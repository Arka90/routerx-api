import { Response } from "express";
import { AuthRequest } from "../auth/auth.middleware";
import { createMonitor, getUserMonitors, updateMonitor, deleteMonitor, getMonitor } from "./monitor.service";
import { sendMonitorNotification } from "../notifications/email.provider";
import { z } from "zod";

const monitorSchema = z.object({
  url: z.string().url(),
  interval_seconds: z.number().min(30).max(3600).optional().default(60),
});

export function addMonitor(req: AuthRequest, res: Response) {
  try {
    const { url, interval_seconds } = monitorSchema.parse(req.body);

    const monitor = createMonitor(req.user!.id, url, interval_seconds);

    // fire-and-forget email notification
    sendMonitorNotification(req.user!.email, url, "CREATED");

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

export function updateMonitorHandler(req: AuthRequest, res: Response) {
  const { id } = req.params;
  const { url, interval_seconds } = req.body;

  try {
    // Basic validation for update
    if (url && !z.string().url().safeParse(url).success) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const updatedMonitor = updateMonitor(
      req.user!.id,
      parseInt(id as string),
      { url, interval_seconds }
    );
    
    res.json(updatedMonitor);
  } catch (error: any) {
    if (error.message === "Monitor not found or unauthorized" || error.message === "Monitor not found") {
       return res.status(404).json({ error: "Monitor not found" });
    }
    res.status(500).json({ error: "Failed to update monitor" });
  }
}

export function deleteMonitorHandler(req: AuthRequest, res: Response) {
  const { id } = req.params;

  try {
    // fetch monitor before deleting to get the URL for the email
    const monitor = getMonitor(req.user!.id, parseInt(id as string));

    deleteMonitor(req.user!.id, parseInt(id as string));

    // fire-and-forget email notification
    if (monitor) {
      sendMonitorNotification(req.user!.email, monitor.url, "DELETED");
    }

    res.json({ message: "Monitor deleted" });
  } catch (error: any) {
     if (error.message === "Monitor not found or unauthorized") {
       return res.status(404).json({ error: "Monitor not found" });
    }
    res.status(500).json({ error: "Failed to delete monitor" });
  }
}
