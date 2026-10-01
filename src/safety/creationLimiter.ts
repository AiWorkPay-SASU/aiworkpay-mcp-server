/** Process-local rolling-hour limiter. Reservations are synchronous, before I/O. */
export class CreationLimiter {
  private readonly entries = new Map<string, { at: number; pending: boolean }>();
  constructor(private readonly maxPerHour: number, private readonly now: () => number = Date.now) {}
  retryAfterSeconds(key?: string): number {
    this.prune();
    if (this.maxPerHour === 0) return Infinity;
    if (key && this.entries.has(key)) return 0;
    if (this.entries.size < this.maxPerHour) return 0;
    const oldest = Math.min(...Array.from(this.entries.values(), (e) => e.at));
    return Math.max(1, Math.ceil((oldest + HOUR_MS - this.now()) / 1000));
  }
  reserve(key: string): number {
    const delay = this.retryAfterSeconds(key);
    if (delay === 0 && !this.entries.has(key)) this.entries.set(key, { at: this.now(), pending: true });
    return delay;
  }
  record(key: string): void { this.entries.set(key, { at: this.now(), pending: false }); }
  private prune(): void {
    for (const [key, entry] of this.entries) if (!entry.pending && entry.at <= this.now() - HOUR_MS) this.entries.delete(key);
  }
}
const HOUR_MS = 60 * 60 * 1000;
