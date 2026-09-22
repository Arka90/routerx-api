import dns from "dns/promises";
import net from "net";
import { config } from "../config";
import { isBlockedAddress } from "./ip";

export class BlockedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedTargetError";
  }
}

export interface ResolvedTarget {
  url: URL;
  hostname: string;
  /** The address we resolved. Connect to *this* rather than resolving again. */
  ip: string;
  port: number;
}

export function parseProbeUrl(raw: string): URL {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedTargetError("Only http and https URLs can be monitored");
  }

  if (url.username || url.password) {
    throw new BlockedTargetError("Credentials in the URL are not supported");
  }

  return url;
}

/**
 * Parse, resolve, and assert every address the hostname points at is publicly
 * routable. Used as a pre-flight check when a monitor is created or edited so
 * the caller gets a clear error instead of a silently failing probe.
 *
 * The per-probe check lives in the probe runner as well: DNS can be re-pointed
 * at a private address after a monitor is accepted, so validating once at
 * creation is not enough on its own.
 */
export async function resolveProbeTarget(raw: string): Promise<ResolvedTarget> {
  const url = parseProbeUrl(raw);

  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
    ? 443
    : 80;

  // An IPv6 literal arrives bracketed ("[::1]"), which dns.lookup cannot
  // resolve — so check literals directly and skip DNS entirely.
  const literal = url.hostname.replace(/^\[|\]$/g, "");

  if (net.isIP(literal)) {
    if (!config.allowPrivateProbeTargets && isBlockedAddress(literal)) {
      throw new BlockedTargetError(
        `${literal} is a private or reserved address and cannot be monitored`
      );
    }
    return { url, hostname: url.hostname, ip: literal, port };
  }

  let addresses: Array<{ address: string }>;

  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new BlockedTargetError(`Could not resolve ${url.hostname}`);
  }

  if (addresses.length === 0) {
    throw new BlockedTargetError(`Could not resolve ${url.hostname}`);
  }

  if (!config.allowPrivateProbeTargets) {
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new BlockedTargetError(
          `${url.hostname} resolves to a private or reserved address (${address}) and cannot be monitored`
        );
      }
    }
  }

  return { url, hostname: url.hostname, ip: addresses[0].address, port };
}

/** True when an already-resolved address is safe to connect to. */
export function isAllowedAddress(ip: string): boolean {
  if (config.allowPrivateProbeTargets) return true;
  return !isBlockedAddress(ip);
}
