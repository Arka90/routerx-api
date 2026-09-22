import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg, requireRole } from "../org/org.middleware";
import {
  createStatusPageHandler,
  deleteStatusPageHandler,
  getStatusPageHandler,
  listStatusPagesHandler,
  setComponentsHandler,
  updateStatusPageHandler,
} from "./status-page.controller";

const router = Router();

router.use(requireAuth, requireOrg);

router.get("/", listStatusPagesHandler);
router.post("/", requireRole("admin"), createStatusPageHandler);
router.get("/:id", getStatusPageHandler);
router.patch("/:id", requireRole("admin"), updateStatusPageHandler);
router.put("/:id/components", requireRole("admin"), setComponentsHandler);
router.delete("/:id", requireRole("admin"), deleteStatusPageHandler);

export default router;
