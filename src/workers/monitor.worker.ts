import { db } from "../core/db/client";
import { sendAlert } from "../modules/notifications/notifier";
import { Monitor } from "../modules/monitor/monitor.service";
import "dotenv/config";
import { runFullProbe } from "../modules/probe/probe.service";

async function checkMonitor(monitor: Monitor) {
  try {
   
    const {diagnosis, dns, tcp, tls, http} = await runFullProbe(monitor.url);

    const last = db
      .prepare(`
          SELECT status 
          FROM probe_results
          WHERE monitor_id = ?
          ORDER BY created_at DESC
          LIMIT 1
      `)
      .get(monitor.id) as any;

    const previousStatus = last?.status;
    const currentStatus = diagnosis.status;

    if (previousStatus && previousStatus !== currentStatus) {
      if (currentStatus === "DOWN") {
        await sendAlert({
          monitorId: monitor.id,
          url: monitor.url,
          status: "DOWN",
          checkedAt: new Date(),
        });
      }

      if (previousStatus === "DOWN" && currentStatus === "UP") {
        await sendAlert({
          monitorId: monitor.id,
          url: monitor.url,
          status: "UP",
          checkedAt: new Date(),
        });
      }
    }

    // SAVE RESULT
    db.prepare(`
      INSERT INTO probe_results 
      (monitor_id, dns, tcp, tls, ttfb, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      monitor.id,
      dns.time,
      tcp?.time,
      tls?.time,
      http?.ttfb,
      diagnosis.status
    );

    console.log(`Checked ${monitor.url} → ${diagnosis.status}`);
  } catch (err) {
    console.error(`Error checking monitor ${monitor.id} (${monitor.url}):`, err);
  } finally {
     // Update next_check_at
     const nextCheck = new Date(Date.now() + monitor.interval_seconds * 1000);
     db.prepare("UPDATE monitors SET next_check_at = ? WHERE id = ?").run(nextCheck.toISOString(), monitor.id);
  }
}

async function runWorker() {
  console.log("RouteRx monitor worker started");
  
  // polling loop
  while (true) {
    try {
        const now = new Date().toISOString();
        const monitors = db
        .prepare("SELECT * FROM monitors WHERE next_check_at <= ?")
        .all(now) as Monitor[];

        if (monitors.length > 0) {
           console.log(`Processing ${monitors.length} monitors...`);
           // Process in parallel but maybe limit concurrency if needed. For now Promise.all is fine for small scale.
           await Promise.all(monitors.map(m => checkMonitor(m)));
        }
    } catch (error) {
        console.error("Worker loop error:", error);
    }
    
    // Sleep until the next monitor is due, instead of a fixed interval
    const nextDue = db
      .prepare("SELECT MIN(next_check_at) as next FROM monitors")
      .get() as { next: string | null } | undefined;

    let sleepMs = 5000; // default fallback
    if (nextDue?.next) {
      const msUntilNext = new Date(nextDue.next).getTime() - Date.now();
      sleepMs = Math.max(1000, Math.min(msUntilNext, 60000)); // clamp between 1s and 60s
    }

    await new Promise(resolve => setTimeout(resolve, sleepMs));
  }
}

runWorker();
