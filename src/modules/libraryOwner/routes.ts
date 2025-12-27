import { Router } from "express";
import { createLibraryOwner } from "./controller.js";
import { loginLibraryOwner } from "./loginController.js";

const router = Router();

router.post("/signup", createLibraryOwner);
router.post("/login", loginLibraryOwner);

export default router;
