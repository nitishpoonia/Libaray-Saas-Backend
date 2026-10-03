import { Router } from "express";
import { createLibraryOwner } from "./controller";
import { loginLibraryOwner } from "./loginController";
import { logoutLibraryOwner } from "./logoutController";
import { authMiddleware } from "../../middleware/auth";
import { authLimiter } from "../../middleware/rateLimiters";

const router = Router();

router.post("/signup", authLimiter, createLibraryOwner);
router.post("/login", authLimiter, loginLibraryOwner);
router.post("/logout", authMiddleware, logoutLibraryOwner);

export default router;
