import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { acceptInviteHandler, peekInviteHandler } from "./org.controller";

const router = Router();

// Unauthenticated on purpose: the invite landing page tells you which
// workspace and which address the invitation is for, before you sign in.
router.get("/:token", peekInviteHandler);

router.post("/:token/accept", requireAuth, acceptInviteHandler);

export default router;
