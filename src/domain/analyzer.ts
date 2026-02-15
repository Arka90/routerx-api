export type ProbeResult = {
  dns?: number | null;
  tcp?: number | null;
  tls?: number | null;
  ttfb?: number | null;
  statusCode?: number | null;
};

export function analyze(result: ProbeResult) {
  if (!result.dns) {
    return {
      status: "DOWN",
      reason: "DNS_FAILURE",
      message: "Domain cannot be resolved. DNS records missing or nameserver down."
    };
  }

  if (!result.tcp) {
    return {
      status: "DOWN",
      reason: "NETWORK_BLOCK",
      message: "Server unreachable. Port blocked, firewall, or host offline."
    };
  }

  if (!result.tls) {
    return {
      status: "DOWN",
      reason: "TLS_FAILURE",
      message: "HTTPS handshake failed. Certificate invalid or HTTPS misconfigured."
    };
  }

  if (result.statusCode && result.statusCode >= 500) {
    return {
      status: "DOWN",
      reason: "SERVER_ERROR",
      message: "Server responded with 5xx. Backend application crashed."
    };
  }

  if (result.ttfb && result.ttfb > 1500) {
    return {
      status: "SLOW",
      reason: "BACKEND_LATENCY",
      message: "Server is responding slowly. Database or backend performance issue."
    };
  }

  if (result.tls && result.tls > 800) {
    return {
      status: "SLOW",
      reason: "TLS_LATENCY",
      message: "TLS handshake slow. CDN, location distance, or overloaded edge."
    };
  }

  if (result.dns && result.dns > 300) {
    return {
      status: "SLOW",
      reason: "DNS_LATENCY",
      message: "DNS resolution slow. Nameserver or DNS provider latency."
    };
  }

  return {
    status: "UP",
    reason: "HEALTHY",
    message: "All network layers operational."
  };
}
