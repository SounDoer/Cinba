export type AttemptLimiterOptions = {
  maximumFailures?: number;
  windowMs?: number;
  now?: () => number;
};

export class AttemptLimiter {
  private readonly maximumFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(options: AttemptLimiterOptions = {}) {
    this.maximumFailures = options.maximumFailures ?? 5;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  private current(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const current = (this.failures.get(key) ?? []).filter((time) => time > cutoff);
    if (current.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, current);
    }
    return current;
  }

  blocked(key: string): boolean {
    return this.current(key).length >= this.maximumFailures;
  }

  recordFailure(key: string): void {
    this.failures.set(key, [...this.current(key), this.now()]);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  clearAll(): void {
    this.failures.clear();
  }
}
