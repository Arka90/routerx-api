export type RootCause =
  | "DNS_FAILURE"
  | "TCP_CONNECTION_FAILED"
  | "TLS_HANDSHAKE_FAILED"
  | "TLS_CERT_EXPIRED"
  | "HTTP_5XX"
  | "HTTP_4XX"
  | "TIMEOUT"
  | "SLOW_RESPONSE"
  | "UNKNOWN";

export function classifyFailure({
  dns,
  tcp,
  tls,
  http,
}: any): RootCause {

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