import { Router } from "express";
import { requestLink, verify } from "./auth.controller";

const router = Router();

router.post("/request-link", requestLink);
router.get("/verify", verify);

export default router;
