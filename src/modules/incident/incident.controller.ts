import { Response } from "express";
import { AuthRequest } from "../auth/auth.middleware";
import { getMonitor } from "../monitor/monitor.service";
import {
  getIncidentsByMonitor,
  getOpenIncident,
  calculateUptime,
} from "./incident.service";

/**
 * GET /incidents/:monitorId
 * List all incidents for a monitor (must belong to the authenticated user).
 */
export function listIncidents(req: AuthRequest, res: Response) {
  const monitorId = Number(req.params.monitorId);
  const monitor = getMonitor(req.user!.id, monitorId);

  if (!monitor) {
    return res.status(404).json({ error: "Monitor not found" });
  }

  const incidents = getIncidentsByMonitor(monitorId);
  const openIncident = getOpenIncident(monitorId);

  res.json({
    monitor_id: monitorId,
    open_incident: openIncident,
    total: incidents.length,
    incidents,
  });
}

/**
 * GET /incidents/:monitorId/uptime?hours=24
 * Returns uptime percentage over a rolling window.
 */
export function getUptimeHandler(req: AuthRequest, res: Response) {
  const monitorId = Number(req.params.monitorId);
  const monitor = getMonitor(req.user!.id, monitorId);

  if (!monitor) {
    return res.status(404).json({ error: "Monitor not found" });
  }

  const hours = Math.max(1, Number(req.query.hours) || 24);
  const uptime = calculateUptime(monitorId, hours);

  res.json({
    monitor_id: monitorId,
    url: monitor.url,
    ...uptime,
  });
}
