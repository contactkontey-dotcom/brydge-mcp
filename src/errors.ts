/**
 * Anything that stopped BRYDGE from answering: a missing key, an unreachable
 * server, a refusal. Never a decision about the action itself. BRYDGE's
 * decisions come back as values, not errors.
 */
export class BrydgeError extends Error {
  /** The HTTP status BRYDGE answered with. Null when BRYDGE was not reached. */
  readonly status: number | null;
  /** BRYDGE's machine-readable reason, when it gave one (for example `nothing_declared`). */
  readonly reason: string | null;
  /** How long BRYDGE asked you to wait before trying again, in seconds. */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    details: { status?: number | null; reason?: string | null; retryAfterSeconds?: number | null; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "BrydgeError";
    this.status = details.status ?? null;
    this.reason = details.reason ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}
