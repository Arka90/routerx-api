import dns from "dns/promises";
import net from "net";
import tls from "tls";
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

/*
 * The HTTP leg lives in domain/http-check.ts. It needs redirect following
 * with a fresh SSRF check per hop, configurable method/headers/body, and
 * response capture for assertions — none of which belong in a one-shot
 * timing probe.
 */
