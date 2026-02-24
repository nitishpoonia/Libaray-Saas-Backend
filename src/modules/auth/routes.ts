import { Router } from "express";
import { createLibraryOwner } from "./controller.js";
import { loginLibraryOwner } from "./loginController.js";
import { logoutLibraryOwner } from "./logoutController.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rateLimiters.js";

const router = Router();

router.post("/signup", authLimiter, createLibraryOwner);
router.post("/login", authLimiter, loginLibraryOwner);
router.post("/logout", authMiddleware, logoutLibraryOwner);

export default router;
