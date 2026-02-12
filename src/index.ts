import express from "express";
import { probeDNS, probeTCP, probeTLS, probeHTTP } from "./probe";
import { addWatch, listWatch } from "./monitor";

const app = express();
app.use(express.json());
console.log("deploy test");


/* health check */
app.get("/health", (req, res) => {
  res.json({ message: "ok" });
});

/* main probe route */
app.get("/probe", async (req, res) => {
  const url = req.query.url as string;

  if (!url) {
    return res.status(400).json({ error: "url query missing" });
  }

  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port
    ? Number(parsed.port)
    : isHttps
    ? 443
    : 80;

  // ---- DNS ----
  const dnsResult = await probeDNS(url);

  let tcpResult = null;
  let tlsResult = null;
  let httpResult = null;

  // ---- TCP ----
  if (dnsResult.success && dnsResult.ip) {
    tcpResult = await probeTCP(dnsResult.ip, port);
  }

  // ---- TLS (only for HTTPS) ----
  if (isHttps && tcpResult?.success && dnsResult.ip) {
    tlsResult = await probeTLS(parsed.hostname, dnsResult.ip, port);
  }

  // ---- HTTP ----
  if (
    (!isHttps && tcpResult?.success) ||
    (isHttps && tlsResult?.success)
  ) {
    httpResult = await probeHTTP(url);
  }

  res.json({
    dns: dnsResult,
    tcp: tcpResult,
    tls: tlsResult,
    http: httpResult,
  });
});

app.post("/watch", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url required" });
  }

  const result = addWatch(url, 20000); // 20s for testing
  res.json(result);
});

app.get("/watch", (req, res) => {
  const result = listWatch();
  res.json(result);
});

app.listen(5001, () => {
  console.log("RouteRx running on port 5001");
});
