"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const probe_1 = require("./probe");
const monitor_1 = require("./monitor");
const analyzer_1 = require("./analyzer");
const app = (0, express_1.default)();
app.use(express_1.default.json());
/* health check */
app.get("/health", (req, res) => {
    res.json({ message: "ok" });
});
/* main probe route */
app.get("/probe", async (req, res) => {
    const url = req.query.url;
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
    const dnsResult = await (0, probe_1.probeDNS)(url);
    let tcpResult = null;
    let tlsResult = null;
    let httpResult = null;
    // ---- TCP ----
    if (dnsResult.success && dnsResult.ip) {
        tcpResult = await (0, probe_1.probeTCP)(dnsResult.ip, port);
    }
    // ---- TLS (only for HTTPS) ----
    if (isHttps && tcpResult?.success && dnsResult.ip) {
        tlsResult = await (0, probe_1.probeTLS)(parsed.hostname, dnsResult.ip, port);
    }
    // ---- HTTP ----
    if ((!isHttps && tcpResult?.success) ||
        (isHttps && tlsResult?.success)) {
        httpResult = await (0, probe_1.probeHTTP)(url);
    }
    const diagnosis = (0, analyzer_1.analyze)({
        dns: dnsResult.time,
        tcp: tcpResult?.time,
        tls: tlsResult?.time,
        ttfb: httpResult?.ttfb,
        statusCode: httpResult?.statusCode,
        success: true
    });
    res.json({
        dns: dnsResult,
        tcp: tcpResult,
        tls: tlsResult,
        http: httpResult,
        diagnosis,
    });
});
app.post("/watch", (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: "url required" });
    }
    const result = (0, monitor_1.addWatch)(url, 20000); // 20s for testing
    res.json(result);
});
app.get("/watch", (req, res) => {
    const result = (0, monitor_1.listWatch)();
    res.json(result);
});
app.listen(5001, () => {
    console.log("RouteRx running on port 5001");
});
