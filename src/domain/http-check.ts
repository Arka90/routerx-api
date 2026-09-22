import http from "http";
import https from "https";
import net from "net";
import { performance } from "perf_hooks";
import { BlockedTargetError, resolveProbeTarget } from "../core/security/ssrf";

/**
 * Responses are read only far enough to evaluate a body assertion. Without a
 * cap, a monitor pointed at a large file would pull the whole thing into the
 * worker's memory every interval.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** Enough to get through a canonical-host or trailing-slash chain, not a loop. */
const MAX_REDIRECTS = 5;

export interface HttpCheckRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs: number;
  followRedirects: boolean;
  /** Only read the response body when something is going to look at it. */
  captureBody: boolean;
}

export interface HttpCheckResult {
  success: boolean;
  statusCode: number | null;
  /** Time to first byte of the final response, in ms. */
  ttfb: number | null;
  /** Total elapsed across every redirect hop, in ms. */
  total: number | null;
  body: string | null;
  finalUrl: string;
  redirectCount: number;
  error: string | null;
  /** Set when a hop resolved to an address we refuse to contact. */
  blocked: boolean;
}

function buildLookup(pinnedIp: string) {
  // Hand Node the address we already resolved and validated. Letting it
  // resolve again would reopen the DNS-rebinding window the SSRF guard closes.
  return (_hostname: string, options: unknown, callback: unknown) => {
    const family = net.isIP(pinnedIp);

    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all) {
      (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: pinnedIp, family },
      ]);
    } else {
      (callback as (e: null, a: string, f: number) => void)(null, pinnedIp, family);
    }
  };
}

interface SingleHopResult {
  statusCode: number | null;
  location: string | null;
  ttfb: number | null;
  body: string | null;
  error: string | null;
}

function requestOnce(
  target: { url: URL; ip: string; port: number },
  request: HttpCheckRequest,
  deadlineMs: number
): Promise<SingleHopResult> {
  return new Promise((resolve) => {
    const { url, ip, port } = target;
    const lib = url.protocol === "https:" ? https : http;
    const start = performance.now();

    let settled = false;
    const finish = (result: SingleHopResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = lib.request(
      {
        hostname: url.hostname,
        path: `${url.pathname || "/"}${url.search}`,
        method: request.method,
        port,
        headers: request.headers,
        timeout: deadlineMs,
        lookup: buildLookup(ip),
      },
      (res) => {
        const ttfb = Math.round(performance.now() - start);
        const location = res.headers.location ?? null;

        if (!request.captureBody) {
          res.destroy();
          finish({
            statusCode: res.statusCode ?? null,
            location,
            ttfb,
            body: null,
            error: null,
          });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;

          if (received <= MAX_BODY_BYTES) {
            chunks.push(chunk);
          } else {
            // Keep what fits, then stop reading rather than buffering more.
            chunks.push(chunk.subarray(0, chunk.length - (received - MAX_BODY_BYTES)));
            res.destroy();
          }
        });

        const done = () =>
          finish({
            statusCode: res.statusCode ?? null,
            location,
            ttfb,
            body: Buffer.concat(chunks).toString("utf8"),
            error: null,
          });

        res.on("end", done);
        // destroy() after the cap fires "close", not "end".
        res.on("close", done);
        res.on("error", done);
      }
    );

    req.on("timeout", () => {
      req.destroy();
      finish({
        statusCode: null,
        location: null,
        ttfb: null,
        body: null,
        error: `Timed out after ${deadlineMs}ms`,
      });
    });

    req.on("error", (error) => {
      finish({
        statusCode: null,
        location: null,
        ttfb: null,
        body: null,
        error: error.message,
      });
    });

    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      req.write(request.body);
    }

    req.end();
  });
}

/**
 * Perform the HTTP leg of a check, following redirects manually.
 *
 * Every hop is resolved and validated separately. A redirect is the classic
 * way around an SSRF filter that only checks the URL the user typed: the
 * first request goes to a public host that answers `302 Location:
 * http://169.254.169.254/`.
 */
export async function httpCheck(request: HttpCheckRequest): Promise<HttpCheckResult> {
  const started = performance.now();

  let currentUrl = request.url;
  let redirectCount = 0;

  while (true) {
    let target;

    try {
      target = await resolveProbeTarget(currentUrl);
    } catch (error) {
      const blocked = error instanceof BlockedTargetError;
      return {
        success: false,
        statusCode: null,
        ttfb: null,
        total: Math.round(performance.now() - started),
        body: null,
        finalUrl: currentUrl,
        redirectCount,
        error: (error as Error).message,
        blocked,
      };
    }

    const remaining = Math.max(
      1000,
      request.timeoutMs - Math.round(performance.now() - started)
    );

    const hop = await requestOnce(
      { url: target.url, ip: target.ip, port: target.port },
      request,
      remaining
    );

    if (hop.error) {
      return {
        success: false,
        statusCode: null,
        ttfb: null,
        total: Math.round(performance.now() - started),
        body: null,
        finalUrl: currentUrl,
        redirectCount,
        error: hop.error,
        blocked: false,
      };
    }

    const isRedirect =
      hop.statusCode !== null &&
      hop.statusCode >= 300 &&
      hop.statusCode < 400 &&
      hop.location !== null;

    if (isRedirect && request.followRedirects) {
      if (redirectCount >= MAX_REDIRECTS) {
        return {
          success: false,
          statusCode: hop.statusCode,
          ttfb: hop.ttfb,
          total: Math.round(performance.now() - started),
          body: null,
          finalUrl: currentUrl,
          redirectCount,
          error: `Stopped after ${MAX_REDIRECTS} redirects`,
          blocked: false,
        };
      }

      redirectCount += 1;
      // Relative Location headers are legal and common.
      currentUrl = new URL(hop.location!, currentUrl).toString();
      continue;
    }

    return {
      success: true,
      statusCode: hop.statusCode,
      ttfb: hop.ttfb,
      total: Math.round(performance.now() - started),
      body: hop.body,
      finalUrl: currentUrl,
      redirectCount,
      error: null,
      blocked: false,
    };
  }
}
