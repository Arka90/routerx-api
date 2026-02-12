import { probeHTTP } from "./probe";

type Status = "UP" | "DOWN";

const state: Record<string, Status> = {};
const timers: Record<string, NodeJS.Timeout> = {};

/* start monitoring */
export function addWatch(url: string, interval = 60000) {
  if (timers[url]) {
    return { message: "Already monitoring" };
  }

  console.log(`Started monitoring ${url}`);

  timers[url] = setInterval(async () => {
    try {
      const result = await probeHTTP(url);
      const newStatus: Status = result.success ? "UP" : "DOWN";
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
        } else {
          console.log(`✅ RECOVERY: ${url} is back UP`);
        }
      }
    } catch (err) {
      console.log("monitor error", err);
    }
  }, interval);

  return { message: "Monitoring started" };
}

/* list all */
export function listWatch() {
  return state;
}
