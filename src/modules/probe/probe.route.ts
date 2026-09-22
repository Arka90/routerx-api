import { Router } from "express";
import { probeController, probeRateLimit } from "./probe.controller";

const router = Router();

router.get("/", probeRateLimit, probeController);

export default router;
