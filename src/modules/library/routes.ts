import express from "express";
import { authMiddleware } from "../../middleware/auth.js";
import {
  createLibrary,
  getLibraries,
  getLibraryOverview,
  updateLibrary,
} from "./controller.js";

const router = express.Router();
router.use(authMiddleware);
router.get("/my-libraries", getLibraries);
router.get("/:id/overview", getLibraryOverview);
router.patch("/update-library-details", updateLibrary);
router.post("/", createLibrary);

export default router;
