import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { addMonitor, listMonitors, updateMonitorHandler, deleteMonitorHandler, getMonitorHandler } from "./monitor.controller";

const router = Router();

router.post("/", requireAuth, addMonitor);
router.get("/", requireAuth, listMonitors);
router.get("/:id", requireAuth, getMonitorHandler);
router.patch("/:id", requireAuth, updateMonitorHandler);
router.delete("/:id", requireAuth, deleteMonitorHandler);

export default router;