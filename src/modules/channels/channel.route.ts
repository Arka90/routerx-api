import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg, requireRole } from "../org/org.middleware";
import {
  createChannelHandler,
  deleteChannelHandler,
  listChannelsHandler,
  testChannelHandler,
  updateChannelHandler,
} from "./channel.controller";

const router = Router();

router.use(requireAuth, requireOrg);

router.get("/", listChannelsHandler);
router.post("/", requireRole("admin"), createChannelHandler);
router.patch("/:id", requireRole("admin"), updateChannelHandler);
router.delete("/:id", requireRole("admin"), deleteChannelHandler);
router.post("/:id/test", requireRole("admin"), testChannelHandler);

export default router;
