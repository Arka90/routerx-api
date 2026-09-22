import net from "net";

/**
 * Address ranges a probe must never reach.
 *
 * Without this check, `GET /probe?url=http://169.254.169.254/latest/meta-data/`
 * turns the API into a reader of cloud instance credentials, and
 * `http://127.0.0.1:6379` turns it into a client for our own Redis. The same
 * applies to any monitor whose hostname resolves inward.
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** [network, prefix length] — every one of these is non-routable on the public internet. */
const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

function isBlockedIpv4(ip: string): boolean {
  const addr = ipv4ToInt(ip);

  return BLOCKED_IPV4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(network) & mask);
  });
}

function isBlockedIpv6(raw: string): boolean {
  const addr = raw.toLowerCase().split("%")[0]; // drop any zone index

  // IPv4-mapped addresses (::ffff:127.0.0.1 and its hex form ::ffff:7f00:1)
  // sit in IPv6 space but reach IPv4 destinations, so map them back.
  const dotted = addr.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIpv4(dotted[1]);

  const hex = addr.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isBlockedIpv4(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
    );
  }

  if (addr === "::" || addr === "::1") return true; // unspecified, loopback
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (addr.startsWith("ff")) return true; // multicast

  return false;
}

/**
 * True when `ip` must not be contacted. Anything that is not a valid IP
 * literal is blocked too — the caller is expected to hand us a resolved
 * address, so a non-address here means something upstream went wrong.
 */
export function isBlockedAddress(ip: string): boolean {
  switch (net.isIP(ip)) {
    case 4:
      return isBlockedIpv4(ip);
    case 6:
      return isBlockedIpv6(ip);
    default:
      return true;
  }
}
