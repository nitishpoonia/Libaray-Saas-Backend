import { Router } from "express";
import { createLibraryOwner } from "./controller.js";
import { loginLibraryOwner } from "./loginController.js";
import { logoutLibraryOwner } from "./logoutController.js";
import { authMiddleware } from "../../middleware/auth.js";

const router = Router();

router.post("/signup", createLibraryOwner);
router.post("/login", loginLibraryOwner);
router.post("/logout", authMiddleware, logoutLibraryOwner);

export default router;
