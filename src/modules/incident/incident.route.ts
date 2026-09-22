import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg } from "../org/org.middleware";
import {
  acknowledgeHandler,
  getUptimeHandler,
  listAllIncidents,
  listIncidentsHandler,
} from "./incident.controller";

const router = Router();

router.use(requireAuth, requireOrg);

router.get("/", listAllIncidents);

// Acknowledging is deliberately available to members: the person who notices
// an outage is not always the person allowed to reconfigure monitoring.
router.post("/:incidentId/ack", acknowledgeHandler);

router.get("/:monitorId", listIncidentsHandler);
router.get("/:monitorId/uptime", getUptimeHandler);

export default router;
