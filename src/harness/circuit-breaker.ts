export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.onStateChange = options.onStateChange;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  canRequest(): boolean {
    this.maybeTransitionToHalfOpen();
    return this.state !== 'open';
  }

  recordSuccess(): void {
    const prev = this.state;
    this.consecutiveFailures = 0;
    this.openedAt = null;
    if (this.state !== 'closed') {
      this.state = 'closed';
      this.onStateChange?.(prev, 'closed');
    }
  }

  recordFailure(): void {
    const prev = this.state;
    this.consecutiveFailures += 1;
    if (
      this.state === 'half_open' ||
      (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold)
    ) {
      this.state = 'open';
      this.openedAt = this.now();
      if (prev !== 'open') this.onStateChange?.(prev, 'open');
    }
  }

  reset(): void {
    const prev = this.state;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    if (prev !== 'closed') this.onStateChange?.(prev, 'closed');
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'open' && this.openedAt !== null) {
      const elapsed = this.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = 'half_open';
        this.onStateChange?.('open', 'half_open');
      }
    }
  }
}
