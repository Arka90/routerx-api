import { probeDNS, probeTCP, probeTLS, probeHTTP } from "../../domain/probe";
import { analyze } from "../../domain/analyzer";

export async function runFullProbe(url: string) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
    ? 443
    : 80;

  const dnsResult = await probeDNS(url);

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
    httpResult = await probeHTTP(url);
  }

  const diagnosis = analyze({
    dns: dnsResult.time,
    tcp: tcpResult?.time,
    tls: tlsResult?.time,
    ttfb: httpResult?.ttfb,
    statusCode: httpResult?.statusCode,
    success: true
  });

  return {
    dns: dnsResult,
    tcp: tcpResult,
    tls: tlsResult,
    http: httpResult,
    diagnosis
  };
}
