import { Response } from "express";
import { AuthRequest } from "../auth/auth.middleware";
import { getMonitor } from "../monitor/monitor.service";
import {
  acknowledgeIncident,
  calculateUptime,
  getOpenIncident,
  listIncidents,
  listOrgIncidents,
} from "./incident.service";

async function requireMonitorScope(req: AuthRequest, res: Response, rawId: unknown) {
  const monitorId = Number(rawId);

  if (!Number.isInteger(monitorId) || monitorId <= 0) {
    res.status(400).json({ error: "Invalid monitor id" });
    return null;
  }

  const monitor = await getMonitor(req.orgId!, monitorId);

  if (!monitor) {
    res.status(404).json({ error: "Monitor not found" });
    return null;
  }

  return monitor;
}

/**
 * Every incident in the workspace, in one request.
 *
 * The incidents page previously fetched monitors and then issued one request
 * per monitor, discarding those with no incidents.
 */
export async function listAllIncidents(req: AuthRequest, res: Response) {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const openOnly = req.query.open === "true";

  const incidents = await listOrgIncidents(req.orgId!, { limit, openOnly });

  res.json({ total: incidents.length, incidents });
}

export async function listIncidentsHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitorScope(req, res, req.params.monitorId);
  if (!monitor) return;

  const incidents = await listIncidents(monitor.id);

  res.json({
    monitor_id: monitor.id,
    open_incident: await getOpenIncident(monitor.id),
    total: incidents.length,
    incidents,
  });
}

export async function getUptimeHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitorScope(req, res, req.params.monitorId);
  if (!monitor) return;

  // Capped at a year: the window only sizes a division, but an unbounded
  // value is free to send and makes the number meaningless.
  const hours = Math.min(8760, Math.max(1, Number(req.query.hours) || 24));

  res.json({
    monitor_id: monitor.id,
    url: monitor.url,
    ...(await calculateUptime(monitor.id, hours)),
  });
}

export async function acknowledgeHandler(req: AuthRequest, res: Response) {
  const incidentId = Number(req.params.incidentId);

  if (!Number.isInteger(incidentId)) {
    return res.status(400).json({ error: "Invalid incident id" });
  }

  const incident = await acknowledgeIncident(req.orgId!, incidentId, req.user!.id);

  if (!incident) {
    return res
      .status(404)
      .json({ error: "Incident not found, or it was already acknowledged" });
  }

  res.json({ message: "Incident acknowledged", incident });
}
