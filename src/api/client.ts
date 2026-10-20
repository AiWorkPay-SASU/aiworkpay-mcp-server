import { z } from 'zod';
import { missionSchema, createSchema, cancelSchema, approveSchema, changesSchema, accountSchema, transactionsSchema } from './schemas.js';
import { randomUUID } from 'node:crypto';
import { log } from '../log.js';
import type {
  AgentAccount,
  ApproveMissionResponse,
  CancelMissionResponse,
  CreateMissionRequest,
  CreateMissionResponse,
  Mission,
  MissionStatus,
  ProofFile,
  RequestChangesResponse,
  TransactionsResponse,
} from './types.js';

/**
 * Thin HTTP client for the AIWorkPay agent API. It authenticates with the
 * agent's own key and holds no other secret: whatever the key may not do, this
 * server cannot do either.
 */

export class AiworkpayApiError extends Error {
  constructor(
    /** Stable code from the API (`error.code`), or a client-side one. */
    readonly code: string,
    message: string,
    /** HTTP status, 0 when no response was received. */
    readonly status: number,
    readonly requestId: string,
    readonly details?: unknown,
    /** From the Retry-After header of a 429. */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'AiworkpayApiError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Sent with every call (e.g. the real client address a trusted service vouches for). Never overrides Authorization. */
  extraHeaders?: Record<string, string>;
}

const CODES_BY_STATUS: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

export class AiworkpayClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createMission(
    body: CreateMissionRequest,
    idempotencyKey: string
  ): Promise<CreateMissionResponse & { replayed: boolean }> {
    const { data, headers } = await this.request<CreateMissionResponse>('POST', '/api/missions', {
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
      schema: createSchema,
    });
    return { ...data, replayed: headers.get('idempotent-replayed') === 'true' };
  }

  async getMission(id: string): Promise<Mission> {
    const { data } = await this.request<Mission>('GET', `/api/missions/${encodeURIComponent(id)}`, { schema: missionSchema });
    return data;
  }

  async cancelMission(id: string): Promise<CancelMissionResponse> {
    const { data } = await this.request<CancelMissionResponse>('POST', `/api/missions/${encodeURIComponent(id)}/cancel`, { schema: cancelSchema });
    return data;
  }

  async approveMission(id: string): Promise<ApproveMissionResponse> {
    const { data } = await this.request<ApproveMissionResponse>('POST', `/api/missions/${encodeURIComponent(id)}/approve`, { schema: approveSchema });
    return data;
  }

  async requestChanges(id: string, feedback: string): Promise<RequestChangesResponse> {
    const { data } = await this.request<RequestChangesResponse>(
      'POST',
      `/api/missions/${encodeURIComponent(id)}/request-changes`,
      { body: { feedback }, schema: changesSchema }
    );
    return data;
  }

  /** The key's own limits, budget used this month, payments and missions by status. */
  async getAccount(): Promise<AgentAccount> {
    const { data } = await this.request<AgentAccount>('GET', '/api/account', { schema: accountSchema });
    return data;
  }

  /** Payments booked on the key, newest first. */
  async listTransactions(params: { missionId?: string; limit?: number; skip?: number } = {}): Promise<TransactionsResponse> {
    const query = new URLSearchParams();
    if (params.missionId) query.set('missionId', params.missionId);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.skip !== undefined) query.set('skip', String(params.skip));
    const suffix = query.size > 0 ? `?${query}` : '';
    const { data } = await this.request<TransactionsResponse>('GET', `/api/transactions${suffix}`, { schema: transactionsSchema });
    return data;
  }

  async listMissions(params: { status?: MissionStatus; limit?: number; skip?: number } = {}): Promise<Mission[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.skip !== undefined) query.set('skip', String(params.skip));
    const suffix = query.size > 0 ? `?${query}` : '';
    const { data } = await this.request<Mission[]>('GET', `/api/missions${suffix}`, { schema: z.array(missionSchema) });
    return data;
  }

  /**
   * Download an uploaded proof. The path is built from the ids against the
   * configured base URL: the attachment's own `url` is never followed, so the
   * agent's key cannot be sent anywhere else.
   */
  async downloadProof(missionId: string, proofId: string, maxBytes: number): Promise<ProofFile> {
    const { response, requestId } = await this.send(
      'GET',
      `/api/missions/${encodeURIComponent(missionId)}/proofs/${encodeURIComponent(proofId)}`,
      { headers: { Accept: '*/*' } }
    );
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new AiworkpayApiError('PROOF_TOO_LARGE', `The file exceeds ${maxBytes} bytes.`, response.status, requestId);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new AiworkpayApiError('PROOF_TOO_LARGE', `The file exceeds ${maxBytes} bytes.`, response.status, requestId);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const content = Buffer.concat(chunks);
    if (content.length > maxBytes) {
      throw new AiworkpayApiError('PROOF_TOO_LARGE', `The file exceeds ${maxBytes} bytes.`, response.status, requestId);
    }
    return { content, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; schema?: z.ZodTypeAny } = {}
  ): Promise<{ data: T; headers: Headers }> {
    const { response, requestId } = await this.send(method, path, init);
    const text = await response.text();
    try {
      const payload: unknown = JSON.parse(text);
      const data = init.schema ? init.schema.parse(payload) : payload;
      return { data: data as T, headers: response.headers };
    } catch {
      throw new AiworkpayApiError('INVALID_RESPONSE', 'AIWorkPay returned an invalid response.', response.status, requestId);
    }
  }

  /** Perform a call; any non-2xx answer becomes an AiworkpayApiError. */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ response: Response; requestId: string }> {
    const requestId = randomUUID();
    const started = Date.now();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.options.extraHeaders,
      ...init.headers,
      Authorization: `Bearer ${this.options.apiKey}`,
      'X-Request-Id': requestId,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      log('warn', 'api.unreachable', { method, path: redactPath(path), request_id: requestId, timed_out: timedOut });
      throw new AiworkpayApiError(
        timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
        timedOut ? 'AIWorkPay did not answer in time.' : 'AIWorkPay could not be reached.',
        0,
        requestId
      );
    }

    log(response.ok ? 'info' : 'warn', 'api.call', {
      method,
      path: redactPath(path),
      status: response.status,
      request_id: requestId,
      duration_ms: Date.now() - started,
    });

    if (!response.ok) {
      const text = await response.text();
      let body: { error?: unknown; code?: unknown; details?: unknown } = {};
      try {
        body = (JSON.parse(text) ?? {}) as typeof body;
      } catch {
        body = {};
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new AiworkpayApiError(
        typeof body.code === 'string' ? body.code : (CODES_BY_STATUS[response.status] ?? 'API_ERROR'),
        typeof body.error === 'string' ? body.error : `AIWorkPay answered HTTP ${response.status}.`,
        response.status,
        requestId,
        body.details,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
      );
    }
    return { response, requestId };
  }
}

/** Mission ids are not secret, but keep logs free of query strings. */
function redactPath(path: string): string {
  return path.split('?')[0] ?? path;
}

