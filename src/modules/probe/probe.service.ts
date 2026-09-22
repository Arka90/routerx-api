import { probeDNS, probeTCP, probeTLS } from "../../domain/probe";
import { httpCheck } from "../../domain/http-check";
import { evaluateAssertions, type AssertionType } from "../../domain/assertions";
import {
  classifyFailure,
  type RootCause,
} from "../../domain/diagnostics/root-cause.classifier";
import { isAllowedAddress } from "../../core/security/ssrf";

export interface CheckConfig {
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body: string | null;
  expected_status_codes: number[];
  assertion_type: AssertionType;
  assertion_value: string | null;
  timeout_ms: number;
  follow_redirects: boolean;
  slow_threshold_ms: number;
}

export interface CheckOutcome {
  status: "UP" | "DOWN" | "SLOW";
  rootCause: RootCause | null;
  /** One line explaining the verdict, used verbatim in alerts. */
  detail: string | null;
  statusCode: number | null;
  blocked: boolean;
  timings: {
    dns: number | null;
    tcp: number | null;
    tls: number | null;
    ttfb: number | null;
    total: number | null;
  };
}

export const DEFAULT_CHECK: Omit<CheckConfig, "url"> = {
  method: "GET",
  request_headers: {},
  request_body: null,
  expected_status_codes: [],
  assertion_type: "none",
  assertion_value: null,
  timeout_ms: 10_000,
  follow_redirects: true,
  slow_threshold_ms: 1_500,
};

/**
 * Run one full check: resolve, connect, handshake, request, assert.
 *
 * The per-layer timings are kept separately because they are the product's
 * actual differentiator — "TLS negotiation went from 40ms to 900ms" is a
 * useful thing to see, and "the site is down" is not.
 */
export async function runCheck(config: CheckConfig): Promise<CheckOutcome> {
  const parsed = new URL(config.url);
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;

  const dnsResult = await probeDNS(config.url);

  const timings: CheckOutcome["timings"] = {
    dns: dnsResult.time,
    tcp: null,
    tls: null,
    ttfb: null,
    total: null,
  };

  if (!dnsResult.success || !dnsResult.ip) {
    return {
      status: "DOWN",
      rootCause: "DNS_FAILURE",
      detail: `Could not resolve ${parsed.hostname}`,
      statusCode: null,
      blocked: false,
      timings,
    };
  }

  // Checked on every run, not just at creation: a hostname that resolved
  // publicly when the monitor was accepted can be re-pointed inward later.
  if (!isAllowedAddress(dnsResult.ip)) {
    return {
      status: "DOWN",
      rootCause: "BLOCKED_TARGET",
      detail: `${parsed.hostname} resolves to a private or reserved address (${dnsResult.ip})`,
      statusCode: null,
      blocked: true,
      timings,
    };
  }

  const tcpResult = await probeTCP(dnsResult.ip, port);
  timings.tcp = tcpResult.time;

  if (!tcpResult.success) {
    return {
      status: "DOWN",
      rootCause: "TCP_CONNECTION_FAILED",
      detail: `Could not open a TCP connection to ${dnsResult.ip}:${port}`,
      statusCode: null,
      blocked: false,
      timings,
    };
  }

  let tlsOk: boolean | null = null;

  if (isHttps) {
    const tlsResult = await probeTLS(parsed.hostname, dnsResult.ip, port);
    timings.tls = tlsResult.time;
    tlsOk = tlsResult.success;

    if (!tlsResult.success) {
      return {
        status: "DOWN",
        rootCause: "TLS_HANDSHAKE_FAILED",
        detail: `TLS handshake with ${parsed.hostname} failed — certificate invalid, expired, or HTTPS misconfigured`,
        statusCode: null,
        blocked: false,
        timings,
      };
    }
  }

  const needsBody = config.assertion_type !== "none" && Boolean(config.assertion_value);

  const http = await httpCheck({
    url: config.url,
    method: config.method,
    headers: {
      "User-Agent": "RouteRX/1.0 (+https://routerx.dev)",
      ...config.request_headers,
      ...(config.request_body
        ? { "Content-Length": String(Buffer.byteLength(config.request_body)) }
        : {}),
    },
    body: config.request_body,
    timeoutMs: config.timeout_ms,
    followRedirects: config.follow_redirects,
    captureBody: needsBody,
  });

  timings.ttfb = http.ttfb;
  timings.total = http.total;

  if (!http.success) {
    return {
      status: "DOWN",
      rootCause: classifyFailure({
        blocked: http.blocked,
        dnsOk: true,
        tcpOk: true,
        tlsOk,
        httpOk: false,
        httpError: http.error,
        statusCode: null,
        assertionFailed: false,
        slow: false,
      }),
      detail: http.error,
      statusCode: null,
      blocked: http.blocked,
      timings,
    };
  }

  const assertion = evaluateAssertions(
    {
      assertion_type: config.assertion_type,
      assertion_value: config.assertion_value,
      expected_status_codes: config.expected_status_codes,
    },
    { statusCode: http.statusCode, body: http.body }
  );

  if (!assertion.passed) {
    return {
      status: "DOWN",
      rootCause: classifyFailure({
        blocked: false,
        dnsOk: true,
        tcpOk: true,
        tlsOk,
        httpOk: true,
        httpError: null,
        statusCode: http.statusCode,
        assertionFailed: true,
        slow: false,
      }),
      detail: assertion.failure,
      statusCode: http.statusCode,
      blocked: false,
      timings,
    };
  }

  const elapsed = http.ttfb ?? http.total ?? 0;

  if (elapsed > config.slow_threshold_ms) {
    return {
      status: "SLOW",
      rootCause: "SLOW_RESPONSE",
      detail: `Responded in ${elapsed}ms (threshold ${config.slow_threshold_ms}ms)`,
      statusCode: http.statusCode,
      blocked: false,
      timings,
    };
  }

  return {
    status: "UP",
    rootCause: null,
    detail: null,
    statusCode: http.statusCode,
    blocked: false,
    timings,
  };
}
