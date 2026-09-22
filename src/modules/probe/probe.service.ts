import { probeDNS, probeTCP, probeTLS, probeHTTP } from "../../domain/probe";
import { analyze } from "../../domain/analyzer";
import { isAllowedAddress } from "../../core/security/ssrf";

export async function runFullProbe(url: string) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
    ? 443
    : 80;

  const dnsResult = await probeDNS(url);

  /**
   * Validation at monitor-creation time is not sufficient on its own: a
   * hostname that resolved to a public address then can be re-pointed at
   * 127.0.0.1 or 169.254.169.254 afterwards, and this runner is what the
   * scheduled worker calls every interval. Check the address we are actually
   * about to connect to, every time.
   */
  if (dnsResult.success && dnsResult.ip && !isAllowedAddress(dnsResult.ip)) {
    return {
      dns: dnsResult,
      tcp: null,
      tls: null,
      http: null,
      blocked: true,
      diagnosis: {
        status: "DOWN" as const,
        reason: "BLOCKED_TARGET",
        message: `${parsed.hostname} resolves to a private or reserved address (${dnsResult.ip}). Probing was refused.`,
      },
    };
  }

  let tcpResult = null;
  let tlsResult = null;
  let httpResult = null;

  if (dnsResult.success && dnsResult.ip) {
    tcpResult = await probeTCP(dnsResult.ip, port);
  }

  if (isHttps && tcpResult?.success && dnsResult.ip) {
    tlsResult = await probeTLS(parsed.hostname, dnsResult.ip, port);
  }

  if ((!isHttps && tcpResult?.success) || (isHttps && tlsResult?.success)) {
    // Pinned to the address we just validated, so the HTTP leg cannot be
    // steered somewhere else by a second DNS answer.
    httpResult = await probeHTTP(url, dnsResult.ip ?? undefined);
  }

  const diagnosis = analyze({
    dns: dnsResult.time,
    tcp: tcpResult?.time,
    tls: tlsResult?.time,
    ttfb: httpResult?.ttfb,
    statusCode: httpResult?.statusCode,
  });

  return {
    dns: dnsResult,
    tcp: tcpResult,
    tls: tlsResult,
    http: httpResult,
    blocked: false,
    diagnosis,
  };
}
