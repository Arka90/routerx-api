"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addWatch = addWatch;
exports.listWatch = listWatch;
const probe_1 = require("./probe");
const state = {};
const timers = {};
/* start monitoring */
function addWatch(url, interval = 60000) {
    if (timers[url]) {
        return { message: "Already monitoring" };
    }
    console.log(`Started monitoring ${url}`);
    timers[url] = setInterval(async () => {
        try {
            const result = await (0, probe_1.probeHTTP)(url);
            const newStatus = result.success ? "UP" : "DOWN";
            const oldStatus = state[url];
            // first run
            if (!oldStatus) {
                state[url] = newStatus;
                console.log(`${url} initial state: ${newStatus}`);
                return;
            }
            // detect change
            if (oldStatus !== newStatus) {
                state[url] = newStatus;
                if (newStatus === "DOWN") {
                    console.log(`🚨 ALERT: ${url} is DOWN`);
                }
                else {
                    console.log(`✅ RECOVERY: ${url} is back UP`);
                }
            }
        }
        catch (err) {
            console.log("monitor error", err);
        }
    }, interval);
    return { message: "Monitoring started" };
}
/* list all */
function listWatch() {
    return state;
}
