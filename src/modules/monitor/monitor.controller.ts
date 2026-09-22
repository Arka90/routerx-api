import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../auth/auth.middleware";
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  getMonitorChannelIds,
  getPolicy,
  getProbeResults,
  listMonitors,
  MonitorExistsError,
  MonitorNotFoundError,
  updateMonitor,
  updatePolicy,
} from "./monitor.service";
import {
  alertPolicySchema,
  createMonitorSchema,
  maintenanceSchema,
  updateMonitorSchema,
} from "./monitor.schema";
import { BlockedTargetError, resolveProbeTarget } from "../../core/security/ssrf";
import { removeMonitorJob, scheduleMonitor } from "../../core/queue/schedulers/monitor.scheduler";
import { sendMonitorNotification } from "../notifications/transactional";
import { execute, query, queryOne } from "../../core/db/client";
import { resolveIncident } from "../incident/incident.service";

/** Loads the monitor and 404s if it isn't in the caller's organization. */
async function requireMonitor(req: AuthRequest, res: Response) {
  const monitorId = Number(req.params.id);

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

export async function addMonitor(req: AuthRequest, res: Response) {
  const parsed = createMonitorSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid monitor" });
  }

  try {
    // Shape is not destination: this is what stops a monitor pointed at the
    // instance metadata endpoint from ever being created.
    await resolveProbeTarget(parsed.data.url);

    const monitor = await createMonitor(req.orgId!, req.user!.id, parsed.data);

    if (!monitor.paused) {
      await scheduleMonitor(monitor.id, monitor.interval_seconds);
    }

    sendMonitorNotification(req.user!.email, monitor.url, "CREATED");

    res.status(201).json({ message: "Monitor created", monitor });
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof MonitorExistsError) {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}

export async function listMonitorsHandler(req: AuthRequest, res: Response) {
  res.json(await listMonitors(req.orgId!));
}

export async function getMonitorHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  res.json({
    ...monitor,
    policy: await getPolicy(monitor.id),
    channel_ids: await getMonitorChannelIds(monitor.id),
  });
}

export async function updateMonitorHandler(req: AuthRequest, res: Response) {
  const existing = await requireMonitor(req, res);
  if (!existing) return;

  const parsed = updateMonitorSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid monitor" });
  }

  try {
    if (parsed.data.url && parsed.data.url !== existing.url) {
      await resolveProbeTarget(parsed.data.url);
    }

    const monitor = await updateMonitor(req.orgId!, existing.id, parsed.data);

    // Interval and paused state both change what should be queued, and the
    // old schedule has to go either way.
    await removeMonitorJob(monitor.id);

    if (!monitor.paused) {
      await scheduleMonitor(monitor.id, monitor.interval_seconds);
    }

    res.json({ message: "Monitor updated", monitor });
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof MonitorNotFoundError) {
      return res.status(404).json({ error: "Monitor not found" });
    }
    throw error;
  }
}

export async function deleteMonitorHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  await deleteMonitor(req.orgId!, monitor.id);
  await removeMonitorJob(monitor.id);

  sendMonitorNotification(req.user!.email, monitor.url, "DELETED");

  res.json({ message: "Monitor deleted" });
}

export async function getMonitorProbes(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));

  res.json(await getProbeResults(monitor.id, limit));
}

// ---------------------------------------------------------------
// Alert policy
// ---------------------------------------------------------------

export async function getPolicyHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  res.json({
    policy: await getPolicy(monitor.id),
    channel_ids: await getMonitorChannelIds(monitor.id),
  });
}

export async function updatePolicyHandler(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  const parsed = alertPolicySchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid policy" });
  }

  const policy = await updatePolicy(monitor.id, parsed.data);

  res.json({
    message: "Alert policy updated",
    policy,
    channel_ids: await getMonitorChannelIds(monitor.id),
  });
}

// ---------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------

export async function scheduleMaintenance(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  const parsed = maintenanceSchema.safeParse(req.body);

  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid maintenance window" });
  }

  const { starts_at, ends_at, reason } = parsed.data;

  // One window per monitor, as before.
  await execute(`DELETE FROM maintenance_windows WHERE monitor_id = $1`, [monitor.id]);

  await execute(
    `INSERT INTO maintenance_windows (monitor_id, starts_at, ends_at, reason)
     VALUES ($1, $2, $3, $4)`,
    [monitor.id, starts_at, ends_at, reason ?? null]
  );

  const active = await queryOne<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM maintenance_windows
        WHERE monitor_id = $1 AND starts_at <= now() AND ends_at >= now()
     ) AS active`,
    [monitor.id]
  );

  await execute(`UPDATE monitors SET in_maintenance = $2 WHERE id = $1`, [
    monitor.id,
    active?.active ?? false,
  ]);

  res.json({ message: "Maintenance scheduled" });
}

export async function getMaintenance(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  const window = await queryOne(
    `SELECT * FROM maintenance_windows WHERE monitor_id = $1 ORDER BY id DESC LIMIT 1`,
    [monitor.id]
  );

  res.json({ maintenance: window ?? null });
}

export async function removeMaintenance(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  await execute(`DELETE FROM maintenance_windows WHERE monitor_id = $1`, [monitor.id]);

  await execute(
    `UPDATE monitors
        SET in_maintenance = false,
            confirmed_status = CASE WHEN confirmed_status = 'MAINTENANCE'
                                    THEN 'UNCONFIRMED' ELSE confirmed_status END
      WHERE id = $1`,
    [monitor.id]
  );

  // An incident that was open before the window started is still open.
  await resolveIncident(monitor.id);

  res.json({ message: "Maintenance removed" });
}

// ---------------------------------------------------------------
// Delivery history
// ---------------------------------------------------------------

export async function listDeliveries(req: AuthRequest, res: Response) {
  const monitor = await requireMonitor(req, res);
  if (!monitor) return;

  const deliveries = await query(
    `SELECT d.id, d.channel_type, d.event, d.status, d.error, d.created_at,
            c.name AS channel_name
       FROM alert_deliveries d
       LEFT JOIN notification_channels c ON c.id = d.channel_id
      WHERE d.monitor_id = $1
      ORDER BY d.created_at DESC
      LIMIT 50`,
    [monitor.id]
  );

  res.json({ deliveries });
}

export const monitorIdParam = z.object({ id: z.coerce.number().int().positive() });
