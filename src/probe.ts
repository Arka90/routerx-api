import dns from "dns/promises";
import net from "net";
import tls from "tls";
import http from "http";
import https from "https";
import { performance } from "perf_hooks";

/* ---------------- DNS ---------------- */

export async function probeDNS(url: string) {
  try {
    const hostname = new URL(url).hostname;

    const start = performance.now();
    const result = await dns.lookup(hostname);
    const end = performance.now();

    return {
      hostname,
      ip: result.address,
      time: Math.round(end - start),
      success: true,
    };
  } catch {
    return {
      hostname: null,
      ip: null,
      time: null,
      success: false,
      error: "DNS lookup failed",
    };
  }
}

/* ---------------- TCP ---------------- */

export function probeTCP(ip: string, port: number): Promise<{
  success: boolean;
  time: number | null;
}> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = performance.now();

    socket.setTimeout(5000);

    socket.connect(port, ip, () => {
      const end = performance.now();
      socket.destroy();

      resolve({
        success: true,
        time: Math.round(end - start),
      });
    });

    socket.on("error", () => {
      socket.destroy();
      resolve({ success: false, time: null });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ success: false, time: null });
    });
  });
}

/* ---------------- TLS ---------------- */

export function probeTLS(
  hostname: string,
  ip: string,
  port: number
): Promise<{ success: boolean; time: number | null }> {
  return new Promise((resolve) => {
    const start = performance.now();

    const socket = tls.connect(
      {
        host: ip,
        port,
        servername: hostname, // SNI
        rejectUnauthorized: true,
      },
      () => {
        const end = performance.now();
        socket.end();

        resolve({
          success: true,
          time: Math.round(end - start),
        });
      }
    );

    socket.on("error", () => {
      socket.destroy();
      resolve({ success: false, time: null });
    });

    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve({ success: false, time: null });
    });
  });
}

/* ---------------- HTTP / TTFB ---------------- */

export function probeHTTP(url: string): Promise<{
  success: boolean;
  statusCode: number | null;
  ttfb: number | null;
}> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const start = performance.now();

    const req = lib.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname || "/",
        method: "GET",
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      },
      (res) => {
        const firstByte = performance.now();

        resolve({
          success: true,
          statusCode: res.statusCode || null,
          ttfb: Math.round(firstByte - start),
        });

        // we only care about first byte
        res.destroy();
      }
    );

    req.on("error", () => {
      resolve({
        success: false,
        statusCode: null,
        ttfb: null,
      });
    });

    req.end();
  });
}
