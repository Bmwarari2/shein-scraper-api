/**
 * Error taxonomy. The split that matters operationally is retryable vs not:
 * retryable errors bubble out of task handlers as non-2xx responses so Cloud
 * Tasks redelivers with backoff; non-retryable errors are recorded on the job
 * item and swallowed so the queue doesn't spin on a permanently broken item.
 */

export class RetryableError extends Error {
  readonly retryable = true;
}

/** Upstream bot wall / challenge page. Retry gets a fresh unlocker session. */
export class BlockedError extends RetryableError {
  constructor(public readonly reason: string) {
    super(`Blocked upstream: ${reason}`);
    this.name = "BlockedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(used: number, budget: number) {
    super(`Daily scrape budget exceeded (${used}/${budget} unlocker calls today)`);
    this.name = "BudgetExceededError";
  }
}

/** Page is real but the expected structure is gone — never retried, always alerted. */
export class SchemaDriftError extends Error {
  constructor(public readonly reason: string) {
    super(`Schema drift: ${reason}`);
    this.name = "SchemaDriftError";
  }
}

/** GBP enforcement: a non-GBP price fails closed rather than being stored. */
export class WrongCurrencyError extends SchemaDriftError {
  constructor(found: string) {
    super(`expected GBP, found ${JSON.stringify(found)}`);
    this.name = "WrongCurrencyError";
  }
}

/** API-surface error with a stable code, serialized by the error handler. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:
      | "INVALID_INPUT"
      | "UNAUTHORIZED"
      | "RATE_LIMITED"
      | "BUDGET_EXCEEDED"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
