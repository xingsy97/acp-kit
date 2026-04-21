/**
 * ACP error classification helpers.
 *
 * The agent side of an ACP connection signals "I cancelled the turn" or
 * "I need you to authenticate first" through JSON-RPC errors with specific
 * codes (and, in older agents, only through error messages). Callers that
 * react differently to those two conditions vs. real failures end up with
 * fragile ad-hoc detectors; these helpers centralize the logic so it stays
 * consistent across the daemon, examples, and tests.
 */

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  data?: {
    message?: unknown;
    details?: unknown;
  };
}

function asErrorLike(error: unknown): ErrorLike | null {
  return error && typeof error === 'object' ? (error as ErrorLike) : null;
}

function describe(error: ErrorLike): string {
  return [error.message, error.data?.message, error.data?.details]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' | ');
}

/**
 * Returns true if `error` looks like the agent cancelled (or aborted) the
 * current operation rather than failing it. Matches JSON-RPC code `-32800`
 * (the ACP cancellation code) plus the common "cancelled" / "canceled" /
 * "aborted" message patterns emitted by older agents.
 */
export function isAcpCancelled(error: unknown): boolean {
  const e = asErrorLike(error);
  if (!e) return false;
  if (e.code === -32800) return true;
  const text = describe(e);
  return text.includes('cancelled') || text.includes('canceled') || text.includes('aborted');
}

/**
 * Returns true if `error` is the agent telling the client "you must run
 * `authenticate` before I can do this". Matches JSON-RPC code `-32000`
 * plus messages containing both "auth" and "require".
 */
export function isAcpAuthRequired(error: unknown): boolean {
  const e = asErrorLike(error);
  if (!e) return false;
  if (e.code === -32000) return true;
  const text = describe(e);
  return /auth/.test(text) && /require/.test(text);
}
