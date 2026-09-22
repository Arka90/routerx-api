import { describe, it, expect } from "vitest";
import { isBlockedAddress } from "../core/security/ip";
import { parseProbeUrl, BlockedTargetError } from "../core/security/ssrf";

describe("blocked address ranges", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.254", "RFC1918 upper bound"],
    ["192.168.1.1", "RFC1918"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["fe80::1", "IPv6 link-local"],
    ["fd00::1", "IPv6 unique-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["not-an-ip", "unparseable"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.15.255.255", // just below the RFC1918 block
    "172.32.0.1", // just above it
    "93.184.216.34",
    "2606:4700:4700::1111",
  ])("allows public address %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("probe URL parsing", () => {
  it("rejects non-http schemes", () => {
    expect(() => parseProbeUrl("file:///etc/passwd")).toThrow(BlockedTargetError);
    expect(() => parseProbeUrl("gopher://example.com")).toThrow(BlockedTargetError);
  });

  it("rejects embedded credentials", () => {
    expect(() => parseProbeUrl("http://user:pass@example.com")).toThrow(
      BlockedTargetError
    );
  });

  it("rejects malformed input", () => {
    expect(() => parseProbeUrl("not a url")).toThrow(BlockedTargetError);
  });

  it("accepts an ordinary https URL", () => {
    expect(parseProbeUrl("https://example.com/status").hostname).toBe("example.com");
  });
});
