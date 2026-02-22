import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { addMonitor, listMonitors, updateMonitorHandler, deleteMonitorHandler, getMonitorHandler, testUpdateMonitorHandler, scheduleMaintenance, removeMaintenance, getMonitorProbes } from "./monitor.controller";

const router = Router();

router.post("/", requireAuth, addMonitor);
router.get("/", requireAuth, listMonitors);
router.get("/:id", requireAuth, getMonitorHandler);
router.patch("/:id", requireAuth, updateMonitorHandler);
router.delete("/:id", requireAuth, deleteMonitorHandler);
router.patch("/:id/test-update", testUpdateMonitorHandler);
router.get("/:id/probes", requireAuth, getMonitorProbes);

// Maintenance
router.post("/:id/maintenance", requireAuth, scheduleMaintenance);
router.delete("/:id/maintenance", requireAuth, removeMaintenance);

export default router;