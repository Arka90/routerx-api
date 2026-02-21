import { Router } from "express";
import { requestLink, verify } from "./auth.controller";

const router = Router();

router.post("/request-otp", requestLink);
router.post("/verify-otp", verify);

export default router;
