import { Request, Response } from "express";
import { startMonitoring, getMonitors } from "./monitor.service";

export function startMonitorController(req: Request, res: Response) {
  const { url, interval } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const result = startMonitoring(url, interval);
  res.json(result);
}

export function getMonitorsController(req: Request, res: Response) {
  const monitors = getMonitors();
  res.json(monitors);
}
