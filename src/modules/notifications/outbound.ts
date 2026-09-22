import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import net from "net";
import { BlockedTargetError, resolveProbeTarget } from "../../core/security/ssrf";
import { ChannelConfigError } from "./types";

/**
 * POST to a user-supplied URL.
 *
 * This is the same SSRF surface as the probe, and it is easy to overlook:
 * a "webhook" channel pointed at http://169.254.169.254/ makes the alert
 * pipeline fetch instance credentials on every outage. Every outbound call
 * resolves and validates the destination first, and connects to the address
 * it validated.
 */
export async function postJson(
  url: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 10_000
): Promise<void> {
  const target = await resolveProbeTarget(url);
  const body = JSON.stringify(payload);

  await new Promise<void>((resolve, reject) => {
    const lib = target.url.protocol === "https:" ? httpsRequest : httpRequest;

    const req = lib(
      {
        hostname: target.url.hostname,
        path: `${target.url.pathname}${target.url.search}`,
        port: target.port,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "RouteRX/1.0",
          ...extraHeaders,
        },
        lookup: (_hostname: string, options: unknown, callback: unknown) => {
          const family = net.isIP(target.ip);
          if (
            typeof options === "object" &&
            options !== null &&
            (options as { all?: boolean }).all
          ) {
            (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(
              null,
              [{ address: target.ip, family }]
            );
          } else {
            (callback as (e: null, a: string, f: number) => void)(null, target.ip, family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain so the socket can be reused

        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(new Error(`Endpoint responded with HTTP ${status}`));
        }
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Validate a webhook URL at save time, so a broken channel is rejected when
 * someone can still fix it rather than silently failing during an outage.
 */
export async function assertWebhookUrl(
  url: unknown,
  allowedHosts?: string[]
): Promise<string> {
  if (typeof url !== "string" || !url.trim()) {
    throw new ChannelConfigError("A webhook URL is required");
  }

  let target;

  try {
    target = await resolveProbeTarget(url.trim());
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      throw new ChannelConfigError(error.message);
    }
    throw error;
  }

  if (target.url.protocol !== "https:") {
    throw new ChannelConfigError("Webhook URLs must use https");
  }

  if (allowedHosts && !allowedHosts.includes(target.url.hostname)) {
    throw new ChannelConfigError(
      `Expected a URL on ${allowedHosts.join(" or ")}, got ${target.url.hostname}`
    );
  }

  return target.url.toString();
}
