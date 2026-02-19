import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { listIncidents, getUptimeHandler } from "./incident.controller";

const router = Router();

router.get("/:monitorId", requireAuth, listIncidents);
router.get("/:monitorId/uptime", requireAuth, getUptimeHandler);

export default router;
