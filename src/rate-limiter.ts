/**
 * Rate Limiter for protection against brute force and DDoS attacks.
 * Uses a sliding window approach with exponential backoff for repeat offenders.
 */
export class RateLimiter {
  // IP -> { count, windowStart, blocked, blockExpires, violations }
  private requests: Map<string, {
    count: number;
    windowStart: number;
    blocked: boolean;
    blockExpires: number;
    violations: number;
  }> = new Map();

  // Track failed lookups per IP (brute force detection)
  private failedLookups: Map<string, { count: number; windowStart: number }> = new Map();

  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxFailedLookups: number;
  private readonly failedLookupWindowMs: number;
  private readonly baseBlockDurationMs: number;

  constructor(options?: {
    windowMs?: number;
    maxRequests?: number;
    maxFailedLookups?: number;
    failedLookupWindowMs?: number;
    baseBlockDurationMs?: number;
  }) {
    this.windowMs = options?.windowMs ?? 60000; // 1 minute window
    this.maxRequests = options?.maxRequests ?? 100; // 100 requests per window
    this.maxFailedLookups = options?.maxFailedLookups ?? 10; // 10 failed lookups
    this.failedLookupWindowMs = options?.failedLookupWindowMs ?? 60000; // 1 minute
    this.baseBlockDurationMs = options?.baseBlockDurationMs ?? 60000; // 1 minute base block
  }

  /**
   * Check if an IP is allowed to make a request.
   * Returns { allowed: boolean, retryAfter?: number }
   */
  checkRequest(ip: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    let record = this.requests.get(ip);

    // Check if currently blocked
    if (record?.blocked) {
      if (now < record.blockExpires) {
        return { allowed: false, retryAfter: Math.ceil((record.blockExpires - now) / 1000) };
      }
      // Block expired, reset but keep violation count
      record.blocked = false;
      record.count = 0;
      record.windowStart = now;
    }

    if (!record) {
      record = { count: 0, windowStart: now, blocked: false, blockExpires: 0, violations: 0 };
      this.requests.set(ip, record);
    }

    // Reset window if expired
    if (now - record.windowStart > this.windowMs) {
      record.count = 0;
      record.windowStart = now;
      // Decay violations over time (reduce by 1 for each clean window)
      if (record.violations > 0) {
        record.violations = Math.max(0, record.violations - 1);
      }
    }

    record.count++;

    if (record.count > this.maxRequests) {
      record.violations++;
      record.blocked = true;
      // Exponential backoff: base * 2^(violations-1), max 1 hour
      const blockDuration = Math.min(
        this.baseBlockDurationMs * Math.pow(2, record.violations - 1),
        3600000
      );
      record.blockExpires = now + blockDuration;
      return { allowed: false, retryAfter: Math.ceil(blockDuration / 1000) };
    }

    return { allowed: true };
  }

  /**
   * Record a failed remote ID lookup (brute force attempt detection).
   * Returns true if the IP should be blocked.
   */
  recordFailedLookup(ip: string): boolean {
    const now = Date.now();
    let record = this.failedLookups.get(ip);

    if (!record) {
      record = { count: 0, windowStart: now };
      this.failedLookups.set(ip, record);
    }

    // Reset window if expired
    if (now - record.windowStart > this.failedLookupWindowMs) {
      record.count = 0;
      record.windowStart = now;
    }

    record.count++;

    if (record.count >= this.maxFailedLookups) {
      // Block this IP for brute forcing
      const requestRecord = this.requests.get(ip) || {
        count: 0,
        windowStart: now,
        blocked: false,
        blockExpires: 0,
        violations: 0
      };
      requestRecord.violations += 2; // Penalize more heavily for brute force
      requestRecord.blocked = true;
      const blockDuration = Math.min(
        this.baseBlockDurationMs * Math.pow(2, requestRecord.violations),
        3600000
      );
      requestRecord.blockExpires = now + blockDuration;
      this.requests.set(ip, requestRecord);

      // Reset failed lookups counter
      record.count = 0;
      record.windowStart = now;

      return true;
    }

    return false;
  }

  /**
   * Clean up old entries to prevent memory leaks.
   * Call this periodically (e.g., every 5 minutes).
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = Math.max(this.windowMs, this.failedLookupWindowMs) * 10;

    for (const [ip, record] of this.requests.entries()) {
      if (!record.blocked && now - record.windowStart > maxAge && record.violations === 0) {
        this.requests.delete(ip);
      }
    }

    for (const [ip, record] of this.failedLookups.entries()) {
      if (now - record.windowStart > maxAge) {
        this.failedLookups.delete(ip);
      }
    }
  }

  /**
   * Get current stats for monitoring.
   */
  getStats(): { trackedIps: number; blockedIps: number; failedLookupTracked: number } {
    let blockedIps = 0;
    const now = Date.now();
    for (const record of this.requests.values()) {
      if (record.blocked && now < record.blockExpires) {
        blockedIps++;
      }
    }
    return {
      trackedIps: this.requests.size,
      blockedIps,
      failedLookupTracked: this.failedLookups.size,
    };
  }
}
