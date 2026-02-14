import { Request, Response } from "express";
import { runFullProbe } from "./probe.service";

export async function probeController(req: Request, res: Response) {
  const url = req.query.url as string;

  if (!url) {
    return res.status(400).json({ error: "url query missing" });
  }

  const result = await runFullProbe(url);

  res.json(result);
}
