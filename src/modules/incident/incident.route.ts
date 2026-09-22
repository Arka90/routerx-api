import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg } from "../org/org.middleware";
import {
  acknowledgeHandler,
  addUpdateHandler,
  getUptimeHandler,
  listAllIncidents,
  listIncidentsHandler,
  listUpdatesHandler,
} from "./incident.controller";
import { requireRole } from "../org/org.middleware";

const router = Router();

router.use(requireAuth, requireOrg);

router.get("/", listAllIncidents);

// Acknowledging is deliberately available to members: the person who notices
// an outage is not always the person allowed to reconfigure monitoring.
router.post("/:incidentId/ack", acknowledgeHandler);

// Posting an update is publishing to customers, so it takes admin. Reading
// the timeline does not.
router.get("/:incidentId/updates", listUpdatesHandler);
router.post("/:incidentId/updates", requireRole("admin"), addUpdateHandler);

router.get("/:monitorId", listIncidentsHandler);
router.get("/:monitorId/uptime", getUptimeHandler);

export default router;
