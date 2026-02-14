"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeDNS = probeDNS;
exports.probeTCP = probeTCP;
exports.probeTLS = probeTLS;
exports.probeHTTP = probeHTTP;
const promises_1 = __importDefault(require("dns/promises"));
const net_1 = __importDefault(require("net"));
const tls_1 = __importDefault(require("tls"));
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const perf_hooks_1 = require("perf_hooks");
/* ---------------- DNS ---------------- */
async function probeDNS(url) {
    try {
        const hostname = new URL(url).hostname;
        const start = perf_hooks_1.performance.now();
        const result = await promises_1.default.lookup(hostname);
        const end = perf_hooks_1.performance.now();
        return {
            hostname,
            ip: result.address,
            time: Math.round(end - start),
            success: true,
        };
    }
    catch {
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
function probeTCP(ip, port) {
    return new Promise((resolve) => {
        const socket = new net_1.default.Socket();
        const start = perf_hooks_1.performance.now();
        socket.setTimeout(5000);
        socket.connect(port, ip, () => {
            const end = perf_hooks_1.performance.now();
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
function probeTLS(hostname, ip, port) {
    return new Promise((resolve) => {
        const start = perf_hooks_1.performance.now();
        const socket = tls_1.default.connect({
            host: ip,
            port,
            servername: hostname, // SNI
            rejectUnauthorized: true,
        }, () => {
            const end = perf_hooks_1.performance.now();
            socket.end();
            resolve({
                success: true,
                time: Math.round(end - start),
            });
        });
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
function probeHTTP(url) {
    return new Promise((resolve) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === "https:" ? https_1.default : http_1.default;
        const start = perf_hooks_1.performance.now();
        const req = lib.request({
            hostname: parsed.hostname,
            path: parsed.pathname || "/",
            method: "GET",
            port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        }, (res) => {
            const firstByte = perf_hooks_1.performance.now();
            resolve({
                success: true,
                statusCode: res.statusCode || null,
                ttfb: Math.round(firstByte - start),
            });
            // we only care about first byte
            res.destroy();
        });
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
