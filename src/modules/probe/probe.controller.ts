import { Response } from "express";
import { z } from "zod";
import { runFullProbe } from "./probe.service";
import { AuthRequest } from "../auth/auth.middleware";
import { BlockedTargetError, resolveProbeTarget } from "../../core/security/ssrf";
import { rateLimit } from "../../core/http/rate-limit";

const querySchema = z.object({
  url: z.string().trim().min(1).max(2048),
});

/**
 * An on-demand probe costs a DNS lookup plus up to three outbound
 * connections, so it gets a tighter budget than the global limiter.
 */
export const probeRateLimit = rateLimit("probe", {
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many probe requests. Try again shortly.",
});

export async function probeController(req: AuthRequest, res: Response) {
  const parsed = querySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: "A url query parameter is required" });
  }

  try {
    // Rejects private, loopback, link-local and reserved destinations before
    // a single packet leaves the host.
    await resolveProbeTarget(parsed.data.url);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  const result = await runFullProbe(parsed.data.url);

  res.json(result);
}
