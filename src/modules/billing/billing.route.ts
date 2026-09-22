import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware";
import { requireOrg, requireRole } from "../org/org.middleware";
import {
  createCheckoutHandler,
  createPortalHandler,
  getBillingHandler,
  listPlansHandler,
} from "./billing.controller";

const router = Router();

// Public: the pricing page needs plans before anyone has signed up.
router.get("/plans", listPlansHandler);

router.get("/", requireAuth, requireOrg, getBillingHandler);

// Only an owner can commit the workspace to a bill.
router.post("/checkout", requireAuth, requireOrg, requireRole("owner"), createCheckoutHandler);
router.post("/portal", requireAuth, requireOrg, requireRole("owner"), createPortalHandler);

export default router;
