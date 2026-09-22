export type RootCause =
  | "DNS_FAILURE"
  | "TCP_CONNECTION_FAILED"
  | "TLS_HANDSHAKE_FAILED"
  | "TLS_CERT_EXPIRED"
  | "HTTP_5XX"
  | "HTTP_4XX"
  | "TIMEOUT"
  | "SLOW_RESPONSE"
  | "BLOCKED_TARGET"
  | "UNKNOWN";

export function classifyFailure({
  dns,
  tcp,
  tls,
  http,
  blocked,
}: any): RootCause {

  // Refused before any connection was attempted -- the target resolves inside
  // a private network. Reported distinctly so an operator can tell a blocked
  // target apart from a genuinely unreachable one.
  if (blocked) return "BLOCKED_TARGET";

  // DNS
  if (!dns?.success) return "DNS_FAILURE";

  // TCP
  if (dns?.success && !tcp?.success) return "TCP_CONNECTION_FAILED";

  // TLS
  if (tcp?.success && !tls?.success) {
    if (tls?.error?.includes("certificate")) return "TLS_CERT_EXPIRED";
    return "TLS_HANDSHAKE_FAILED";
  }

  // HTTP status
  if (http?.statusCode >= 500) return "HTTP_5XX";
  if (http?.statusCode >= 400) return "HTTP_4XX";

  // timeout
  if (!http?.success) return "TIMEOUT";

  // degraded
  if (http?.ttfb && http.ttfb > 2000) return "SLOW_RESPONSE";

  return "UNKNOWN";
}