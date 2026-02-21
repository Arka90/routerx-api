import { Response } from "express";
import { AuthRequest } from "../auth/auth.middleware";
import { createMonitor, getUserMonitors, updateMonitor, deleteMonitor, getMonitor } from "./monitor.service";
import { sendMonitorNotification } from "../notifications/email.provider";
import { z } from "zod";

import { db } from "../../core/db/client";
import { removeMonitorJob, scheduleMonitor } from "../../core/queue/schedulers/monitor.scheduler";

const monitorSchema = z.object({
  url: z.string().url(),
  interval_seconds: z.number().min(30).max(3600).optional().default(60),
});

export async function addMonitor(req: AuthRequest, res: Response) {
  try {
    const { url, interval_seconds } = monitorSchema.parse(req.body);

    const monitor = createMonitor(req.user!.id, url, interval_seconds);

    // 🔥 schedule first check
    await scheduleMonitor(monitor.id, monitor.url, monitor.interval_seconds);

    // fire-and-forget email notification
    // sendMonitorNotification(req.user!.email, url, "CREATED");
    console.log("Monitor created");

    res.status(201).json({
      message: "Monitor created",
      monitor,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.format() });
      return;
    }
    if (error.message === "Monitor already exists") {
      res.status(409).json({ error: "You are already monitoring this URL" });
      return;
    }
    console.log(error);
    
    res.status(500).json({ error: "Failed to create monitor" });
  }
}


export function listMonitors(req: AuthRequest, res: Response) {
  const monitors = getUserMonitors(req.user!.id);
  res.json(monitors);
}

export function getMonitorHandler(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const monitor = getMonitor(req.user!.id, Number(id));
  
  if (!monitor) {
    return res.status(404).json({ error: "Monitor not found" });
  }

  res.json(monitor);
}

export async function updateMonitorHandler(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const monitorId = parseInt(id as string);

  const { url, interval_seconds } = req.body;

  try {
    if (url && !z.string().url().safeParse(url).success) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const updatedMonitor = updateMonitor(
      req.user!.id,
      monitorId,
      { url, interval_seconds }
    );

    // 🔥 remove old scheduled job
    await removeMonitorJob(monitorId);

    // 🔥 reschedule with new config
    await scheduleMonitor(
      updatedMonitor.id,
      updatedMonitor.url,
      updatedMonitor.interval_seconds
    );

    res.json(updatedMonitor);
  } catch (error: any) {
    if (error.message === "Monitor not found or unauthorized" || error.message === "Monitor not found") {
      return res.status(404).json({ error: "Monitor not found" });
    }
    res.status(500).json({ error: "Failed to update monitor" });
  }
}


export async function deleteMonitorHandler(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const monitorId = parseInt(id as string);

  try {
    const monitor = getMonitor(req.user!.id, monitorId);

    deleteMonitor(req.user!.id, monitorId);

    // 🔥 stop future probes
    await removeMonitorJob(monitorId);

    if (monitor) {
      // sendMonitorNotification(req.user!.email, monitor.url, "DELETED");
      console.log("Monitor deleted");
    }

    res.json({ message: "Monitor deleted" });
  } catch (error: any) {
    if (error.message === "Monitor not found or unauthorized") {
      return res.status(404).json({ error: "Monitor not found" });
    }
    res.status(500).json({ error: "Failed to delete monitor" });
  }
}

export async function testUpdateMonitorHandler(req: AuthRequest, res: Response) {
  // just update the url for test
  const { id } = req.params;
  // read the test from the body
  const { url } = req.body;
  const monitorId = parseInt(id as string);
  db.prepare(`UPDATE monitors SET url = ? WHERE id = ?`).run(url, monitorId);
  res.json({ message: "Monitor updated" });
}

export function scheduleMaintenance(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const monitorId = parseInt(id as string);
  const { starts_at, ends_at, reason } = req.body;

  try {
    // verify monitor belongs to user
    const monitor = getMonitor(req.user!.id, monitorId);
    if (!monitor) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    // insert maintenance window
    db.prepare(`
      INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason)
      VALUES (?, ?, ?, ?)
    `).run(monitorId, starts_at, ends_at, reason ?? null);

    // flag monitor as in maintenance
    db.prepare(`UPDATE monitors SET in_maintenance = 1 WHERE id = ?`).run(monitorId);

    res.json({ message: "Maintenance scheduled" });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Failed to schedule maintenance" });
  }
}

export function removeMaintenance(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const monitorId = parseInt(id as string);

  try {
    // verify monitor belongs to user
    const monitor = getMonitor(req.user!.id, monitorId);
    if (!monitor) {
      return res.status(404).json({ error: "Monitor not found" });
    }

    // remove all maintenance windows for this monitor
    db.prepare(`DELETE FROM maintenance_windows WHERE monitor_id = ?`).run(monitorId);

    // clear maintenance flag
    db.prepare(`UPDATE monitors SET in_maintenance = 0 WHERE id = ?`).run(monitorId);

    res.json({ message: "Maintenance removed" });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: "Failed to remove maintenance" });
  }
}
