import { randomUUID } from 'node:crypto';
import { log } from '../log.js';
import type {
  ApproveMissionResponse,
  CancelMissionResponse,
  CreateMissionRequest,
  CreateMissionResponse,
  Mission,
  MissionStatus,
  RequestChangesResponse,
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
    });
    return { ...data, replayed: headers.get('idempotent-replayed') === 'true' };
  }

  async getMission(id: string): Promise<Mission> {
    const { data } = await this.request<Mission>('GET', `/api/missions/${encodeURIComponent(id)}`);
    return data;
  }

  async cancelMission(id: string): Promise<CancelMissionResponse> {
    const { data } = await this.request<CancelMissionResponse>('POST', `/api/missions/${encodeURIComponent(id)}/cancel`);
    return data;
  }

  async approveMission(id: string): Promise<ApproveMissionResponse> {
    const { data } = await this.request<ApproveMissionResponse>('POST', `/api/missions/${encodeURIComponent(id)}/approve`);
    return data;
  }

  async requestChanges(id: string, feedback: string): Promise<RequestChangesResponse> {
    const { data } = await this.request<RequestChangesResponse>(
      'POST',
      `/api/missions/${encodeURIComponent(id)}/request-changes`,
      { body: { feedback } }
    );
    return data;
  }

  async listMissions(params: { status?: MissionStatus; limit?: number; skip?: number } = {}): Promise<Mission[]> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.skip !== undefined) query.set('skip', String(params.skip));
    const suffix = query.size > 0 ? `?${query}` : '';
    const { data } = await this.request<Mission[]>('GET', `/api/missions${suffix}`);
    return data;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ data: T; headers: Headers }> {
    const requestId = randomUUID();
    const started = Date.now();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
      'X-Request-Id': requestId,
      ...init.headers,
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

    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    log(response.ok ? 'info' : 'warn', 'api.call', {
      method,
      path: redactPath(path),
      status: response.status,
      request_id: requestId,
      duration_ms: Date.now() - started,
    });

    if (!response.ok) {
      const body = (payload ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
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

    if (payload === undefined) {
      throw new AiworkpayApiError('INVALID_RESPONSE', 'AIWorkPay returned a non-JSON response.', response.status, requestId);
    }
    return { data: payload as T, headers: response.headers };
  }
}

/** Mission ids are not secret, but keep logs free of query strings. */
function redactPath(path: string): string {
  return path.split('?')[0] ?? path;
}
