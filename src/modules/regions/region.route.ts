import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg } from "../org/org.middleware";
import { listRegions } from "./region.service";

const router = Router();

/**
 * Which vantage points exist. Read-only over HTTP on purpose: a region comes
 * into existence when a worker in it starts up and announces itself, not
 * because someone typed its name into a form.
 */
router.get("/", requireAuth, requireOrg, async (_req, res) => {
  res.json({ regions: await listRegions(true) });
});

export default router;
