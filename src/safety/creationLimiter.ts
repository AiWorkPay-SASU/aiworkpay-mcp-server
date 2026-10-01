/**
 * Caps how many missions this server creates per rolling hour, so that an
 * agent stuck in a loop cannot flood the marketplace or its owner with payment
 * links. Process-local: it complements, not replaces, server-side limits.
 */
export class CreationLimiter {
  private readonly timestamps: number[] = [];
  /** Idempotency keys already created: retrying them creates nothing. */
  private readonly created = new Set<string>();

  constructor(
    private readonly maxPerHour: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Seconds until a creation is allowed again, 0 if allowed now. */
  retryAfterSeconds(idempotencyKey?: string): number {
    if (idempotencyKey && this.created.has(idempotencyKey)) return 0;
    this.prune();
    if (this.timestamps.length < this.maxPerHour) return 0;
    if (this.maxPerHour === 0) return Number.POSITIVE_INFINITY;
    const oldest = this.timestamps[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + HOUR_MS - this.now()) / 1000));
  }

  record(idempotencyKey: string): void {
    this.timestamps.push(this.now());
    this.created.add(idempotencyKey);
  }

  private prune(): void {
    const threshold = this.now() - HOUR_MS;
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) <= threshold) this.timestamps.shift();
  }
}

const HOUR_MS = 60 * 60 * 1000;
