import { Router } from "express";
import { probeController } from "./probe.controller";

const router = Router();

router.get("/", probeController);

export default router;
