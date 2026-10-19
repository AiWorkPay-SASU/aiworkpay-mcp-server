import type { Mission } from '../src/api/types.js';

/**
 * In-memory stand-in for the AIWorkPay agent API, implementing the contract of
 * Aiworkpay-v2: Bearer key, Idempotency-Key replay, owner-only reads.
 */
export class FakeAiworkpayApi {
  readonly missions = new Map<string, Mission & { apiKey: string; idem?: string; fp?: string }>();
  readonly requests: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  private seq = 0;
  /** Uploaded proof contents, by attachment id. */
  readonly files = new Map<string, { content: Buffer; contentType: string }>();
  /** Payments booked on a key (what the agent paid for its missions). */
  readonly payments: { id: string; missionId: string; amount: number; currency: string; createdAt: string; apiKey: string }[] = [];
  /** Caps and permissions the API reports for the calling key. */
  limits: { maxMissionBudget: number | null; monthlyBudget: number | null } = { maxMissionBudget: 100, monthlyBudget: 300 };
  scopes = ['missions:read', 'missions:write', 'missions:approve'];
  /** Next response to force, e.g. a 502, consumed once. */
  failNext?: { status: number; body: unknown; headers?: Record<string, string> };

  constructor(private readonly keys = ['awp_test']) {}

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method: init.method ?? 'GET', url: url.pathname + url.search, headers, body });

    if (this.failNext) {
      const { status, body: failBody, headers: failHeaders } = this.failNext;
      this.failNext = undefined;
      return json(status, failBody, failHeaders);
    }

    const key = headers.authorization?.replace(/^Bearer /, '');
    if (!key) return json(401, { error: 'Clé API manquante', code: 'UNAUTHORIZED' });
    if (!this.keys.includes(key)) return json(403, { error: 'Clé API invalide', code: 'INVALID_API_KEY' });

    const method = init.method ?? 'GET';

    const proof = url.pathname.match(/^\/api\/missions\/([^/]+)\/proofs\/([^/]+)$/);
    if (proof && method === 'GET') {
      const mission = this.missions.get(decodeURIComponent(proof[1]!));
      const file = this.files.get(decodeURIComponent(proof[2]!));
      if (!mission || mission.apiKey !== key || !file || !['DELIVERED', 'COMPLETED'].includes(mission.status)) {
        return json(404, { error: 'Fichier introuvable', code: 'PROOF_NOT_FOUND' });
      }
      return new Response(new Uint8Array(file.content), {
        status: 200,
        headers: { 'content-type': file.contentType, 'content-length': String(file.content.length) },
      });
    }

    if (url.pathname === '/api/account' && method === 'GET') return this.account(key);
    if (url.pathname === '/api/transactions' && method === 'GET') return this.transactions(key, url.searchParams);

    const action = url.pathname.match(/^\/api\/missions\/([^/]+)\/(cancel|approve|request-changes)$/);
    if (action && method === 'POST') return this.act(key, decodeURIComponent(action[1]!), action[2]!, body);

    const match = url.pathname.match(/^\/api\/missions(?:\/([^/]+))?$/);
    if (!match) return json(404, { error: 'not found' });
    const id = match[1] ? decodeURIComponent(match[1]) : undefined;

    if (method === 'POST' && !id) {
      const idem = headers['idempotency-key'];
      const fp = JSON.stringify(body);
      if (idem) {
        const existing = [...this.missions.values()].find((m) => m.apiKey === key && m.idem === idem);
        if (existing) {
          if (existing.fp !== fp) return json(422, { error: 'reused', code: 'IDEMPOTENCY_KEY_REUSED' });
          return json(200, { mission: strip(existing), payment: checkout(existing) }, { 'Idempotent-Replayed': 'true' });
        }
      }
      const now = new Date().toISOString();
      const missionId = `m-${++this.seq}`;
      const mission = {
        id: missionId,
        title: body.title,
        description: body.description,
        budget: String(body.budget),
        currency: body.currency,
        deadline: new Date(body.deadline).toISOString(),
        priority: body.priority,
        status: 'PAYMENT_PENDING' as const,
        checkoutUrl: `https://checkout.stripe.com/c/pay/cs_${missionId}`,
        checkoutExpiresAt: new Date(Date.now() + 864e5).toISOString(),
        resultNote: null,
        resultData: null,
        deliveredAt: null,
        assignedToUserId: null,
        createdAt: now,
        updatedAt: now,
        attachments: [],
        apiKey: key,
        idem,
        fp,
      };
      this.missions.set(missionId, mission);
      return json(201, { mission: strip(mission), payment: checkout(mission) });
    }

    if (method === 'GET' && id) {
      const mission = this.missions.get(id);
      if (!mission || mission.apiKey !== key) return json(404, { error: 'Mission introuvable', code: 'MISSION_NOT_FOUND' });
      return json(200, strip(mission));
    }

    if (method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const list = [...this.missions.values()]
        .filter((m) => m.apiKey === key && (!status || m.status === status))
        .reverse()
        .slice(skip, skip + limit);
      return json(200, list.map(strip));
    }

    return json(405, { error: 'method' });
  };

  private act(key: string, id: string, action: string, body: { feedback?: string } | undefined): Response {
    const mission = this.missions.get(id);
    if (!mission || mission.apiKey !== key) return json(404, { error: 'Mission introuvable', code: 'MISSION_NOT_FOUND' });

    if (action === 'cancel') {
      if (mission.status === 'CANCELED') return json(200, { mission: strip(mission), payment: 'already_canceled' });
      if (!['PAYMENT_PENDING', 'PUBLISHED'].includes(mission.status)) {
        return json(409, { error: 'engagé', code: 'MISSION_NOT_CANCELABLE', details: { status: mission.status } });
      }
      const payment = mission.status === 'PUBLISHED' ? 'refunded' : 'checkout_closed';
      this.advance(id, { status: 'CANCELED' });
      return json(200, { mission: strip(mission), payment });
    }

    if (action === 'approve') {
      if (mission.status === 'COMPLETED') return json(200, { mission: strip(mission), alreadyApproved: true });
      if (mission.status !== 'DELIVERED') return json(409, { error: 'pas livrée', code: 'MISSION_NOT_DELIVERED' });
      this.advance(id, { status: 'COMPLETED' });
      const budget = Number(mission.budget);
      return json(200, {
        mission: strip(mission),
        alreadyApproved: false,
        commission: { payworkerAmount: budget * 0.9, platformFeeAmount: budget * 0.1, transferStatus: 'SUCCEEDED' },
      });
    }

    // request-changes
    if (mission.status !== 'DELIVERED') return json(409, { error: 'pas livrée', code: 'MISSION_NOT_DELIVERED' });
    if ((mission.revisionCount ?? 0) >= 3) return json(409, { error: 'limite', code: 'REVISION_LIMIT_REACHED' });
    this.advance(id, { status: 'IN_PROGRESS', revisionFeedback: body?.feedback, revisionCount: (mission.revisionCount ?? 0) + 1 });
    return json(200, { mission: strip(mission), revisionsLeft: 3 - (mission.revisionCount ?? 0) });
  }

  /** The agent's human owner pays the Checkout page: the mission is published and the payment booked. */
  pay(id: string): void {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`unknown mission ${id}`);
    this.advance(id, { status: 'PUBLISHED' });
    this.payments.push({ id: `txn_${this.payments.length + 1}`, missionId: id, amount: Number(mission.budget), currency: mission.currency, createdAt: new Date().toISOString(), apiKey: mission.apiKey });
  }

  private account(key: string): Response {
    const missions = [...this.missions.values()].filter((m) => m.apiKey === key);
    const committed = missions.filter((m) => m.status !== 'CANCELED').reduce((sum, m) => sum + Number(m.budget), 0);
    const paid = this.payments.filter((p) => p.apiKey === key);
    const refunded = paid.filter((p) => this.missions.get(p.missionId)?.status === 'CANCELED').reduce((sum, p) => sum + p.amount, 0);
    const totalPaid = paid.reduce((sum, p) => sum + p.amount, 0);
    const byStatus: Record<string, number> = {};
    for (const m of missions) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    const month = new Date(); month.setUTCDate(1); month.setUTCHours(0, 0, 0, 0);
    return json(200, {
      key: { id: 'key_1', label: 'Agent test', prefix: key.slice(0, 12), scopes: this.scopes, active: true, expiresAt: null, lastUsedAt: null, createdAt: month.toISOString() },
      limits: this.limits,
      usage: {
        monthStart: month.toISOString(), committedThisMonth: committed,
        remainingThisMonth: this.limits.monthlyBudget === null ? null : Math.max(0, this.limits.monthlyBudget - committed),
        totalPaid, totalRefunded: refunded, netPaid: totalPaid - refunded,
      },
      missions: { total: missions.length, byStatus },
      webhook: { configured: false },
    });
  }

  private transactions(key: string, params: URLSearchParams): Response {
    const limit = Number(params.get('limit') ?? 50), skip = Number(params.get('skip') ?? 0), missionId = params.get('missionId');
    const rows = this.payments.filter((p) => p.apiKey === key && (!missionId || p.missionId === missionId)).reverse();
    return json(200, {
      total: rows.length,
      transactions: rows.slice(skip, skip + limit).map((p) => {
        const status = this.missions.get(p.missionId)?.status ?? null;
        return { id: p.id, type: 'AGENT_PAYMENT', status: 'SUCCEEDED', amount: p.amount, currency: p.currency, missionId: p.missionId,
          missionStatus: status, refunded: status === 'CANCELED', createdAt: p.createdAt };
      }),
    });
  }

  /** Simulate the Payworker's side: payment, acceptance, delivery. */
  advance(id: string, patch: Partial<Mission>): void {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`unknown mission ${id}`);
    Object.assign(mission, patch, { updatedAt: new Date().toISOString() });
  }
}

function strip(m: Mission & { apiKey?: string; idem?: string; fp?: string }): Mission {
  const { apiKey: _a, idem: _i, fp: _f, ...mission } = m;
  return mission;
}

function checkout(m: Mission) {
  return { mode: 'checkout', checkoutSessionId: `cs_${m.id}`, url: m.checkoutUrl, expiresAt: m.checkoutExpiresAt };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
