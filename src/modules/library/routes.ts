import express from "express";
import { auth } from "../../middleware/auth.js";
import { createLibrary } from "./controller.js";

const router = express.Router();

router.post("/", auth, createLibrary);

export default router;
