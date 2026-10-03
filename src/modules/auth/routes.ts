import { Router } from "express";
import { authMiddleware } from "../../middleware/auth";
import { authLimiter, loginAccountLimiter } from "../../middleware/rateLimiters";
import * as controller from "./controller";

const router = Router();

router.post("/signup", authLimiter, controller.signup);
router.post("/login", authLimiter, loginAccountLimiter, controller.login);
router.post("/refresh", controller.refresh);
router.post("/logout", authMiddleware, controller.logout);
router.post("/logout-all", authMiddleware, controller.logoutAll);

export default router;
