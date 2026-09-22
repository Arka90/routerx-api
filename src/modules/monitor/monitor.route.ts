import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg, requireRole } from "../org/org.middleware";
import {
  addMonitor,
  deleteMonitorHandler,
  getMaintenance,
  getMonitorHandler,
  getMonitorProbes,
  getPolicyHandler,
  listDeliveries,
  listMonitorsHandler,
  removeMaintenance,
  scheduleMaintenance,
  updateMonitorHandler,
  updatePolicyHandler,
} from "./monitor.controller";

const router = Router();

// Every route is organization-scoped. Members can read; changing what is
// monitored, or how it alerts, takes admin.
router.use(requireAuth, requireOrg);

router.get("/", listMonitorsHandler);
router.post("/", requireRole("admin"), addMonitor);

router.get("/:id", getMonitorHandler);
router.patch("/:id", requireRole("admin"), updateMonitorHandler);
router.delete("/:id", requireRole("admin"), deleteMonitorHandler);

router.get("/:id/probes", getMonitorProbes);
router.get("/:id/deliveries", listDeliveries);

router.get("/:id/policy", getPolicyHandler);
router.put("/:id/policy", requireRole("admin"), updatePolicyHandler);

router.get("/:id/maintenance", getMaintenance);
router.post("/:id/maintenance", requireRole("admin"), scheduleMaintenance);
router.delete("/:id/maintenance", requireRole("admin"), removeMaintenance);

export default router;
