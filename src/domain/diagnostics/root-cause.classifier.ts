export type RootCause =
  | "DNS_FAILURE"
  | "TCP_CONNECTION_FAILED"
  | "TLS_HANDSHAKE_FAILED"
  | "TIMEOUT"
  | "REDIRECT_LOOP"
  | "UNEXPECTED_STATUS"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "ASSERTION_FAILED"
  | "SLOW_RESPONSE"
  | "BLOCKED_TARGET"
  | "UNKNOWN";

export interface ClassifierInput {
  blocked: boolean;
  dnsOk: boolean;
  tcpOk: boolean | null;
  tlsOk: boolean | null;
  httpOk: boolean;
  httpError: string | null;
  statusCode: number | null;
  assertionFailed: boolean;
  slow: boolean;
}

/**
 * Name the layer that broke, so an alert says "TLS handshake failed" rather
 * than "the site is down". Ordered from the outside in: a DNS failure makes
 * everything after it meaningless.
 */
export function classifyFailure(input: ClassifierInput): RootCause {
  if (input.blocked) return "BLOCKED_TARGET";
  if (!input.dnsOk) return "DNS_FAILURE";
  if (input.tcpOk === false) return "TCP_CONNECTION_FAILED";
  if (input.tlsOk === false) return "TLS_HANDSHAKE_FAILED";

  if (!input.httpOk) {
    const error = input.httpError ?? "";
    if (/timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(error)) return "TIMEOUT";
    if (/redirects/i.test(error)) return "REDIRECT_LOOP";
    return "UNKNOWN";
  }

  if (input.assertionFailed) {
    const status = input.statusCode ?? 0;
    if (status >= 500) return "HTTP_5XX";
    if (status >= 400) return "HTTP_4XX";
    // Status was acceptable, so it was the body assertion that failed.
    if (status >= 200 && status < 400) return "ASSERTION_FAILED";
    return "UNEXPECTED_STATUS";
  }

  if (input.slow) return "SLOW_RESPONSE";

  return "UNKNOWN";
}
