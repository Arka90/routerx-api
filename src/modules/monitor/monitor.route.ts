import { Router } from "express";
import { startMonitorController, getMonitorsController } from "./monitor.controller";

const router = Router();

router.post("/", startMonitorController);
router.get("/", getMonitorsController);

export default router;
