import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg, requireRole } from "./org.middleware";
import {
  acceptInviteHandler,
  createInviteHandler,
  createOrganizationHandler,
  listInvitesHandler,
  listMembersHandler,
  listOrganizations,
  peekInviteHandler,
  removeMemberHandler,
  revokeInviteHandler,
  updateMemberRoleHandler,
} from "./org.controller";

const router = Router();

router.get("/", requireAuth, listOrganizations);
router.post("/", requireAuth, createOrganizationHandler);

router.get("/members", requireAuth, requireOrg, listMembersHandler);
router.patch(
  "/members/:userId",
  requireAuth,
  requireOrg,
  requireRole("admin"),
  updateMemberRoleHandler
);
router.delete(
  "/members/:userId",
  requireAuth,
  requireOrg,
  requireRole("admin"),
  removeMemberHandler
);

router.get("/invites", requireAuth, requireOrg, requireRole("admin"), listInvitesHandler);
router.post("/invites", requireAuth, requireOrg, requireRole("admin"), createInviteHandler);
router.delete(
  "/invites/:inviteId",
  requireAuth,
  requireOrg,
  requireRole("admin"),
  revokeInviteHandler
);

export default router;
