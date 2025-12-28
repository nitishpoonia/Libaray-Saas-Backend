import { Router } from "express";
import { createLibraryOwner } from "./controller.js";
import { loginLibraryOwner } from "./loginController.js";
import { logoutLibraryOwner } from "./logoutController.js";
import { auth } from "../../middleware/auth.js";

const router = Router();

router.post("/signup", createLibraryOwner);
router.post("/login", loginLibraryOwner);
router.post("/logout", auth, logoutLibraryOwner);

export default router;
