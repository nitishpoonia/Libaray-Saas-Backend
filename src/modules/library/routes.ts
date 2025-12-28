import express from "express";
import { auth } from "../../middleware/auth.js";
import {
  createLibrary,
  getLibraries,
  getLibraryOverview,
} from "./controller.js";

const router = express.Router();

router.post("/", auth, createLibrary);
router.get("/my-libraries", auth, getLibraries);
router.get("/:id/overview", auth, getLibraryOverview);
export default router;
