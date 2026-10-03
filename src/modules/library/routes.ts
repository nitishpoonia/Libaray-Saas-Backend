import express from "express";
import { authMiddleware } from "../../middleware/auth";
import {
  createLibrary,
  getLibraries,
  getLibraryOverview,
  updateLibrary,
} from "./controller";

const router = express.Router();
router.use(authMiddleware);
router.get("/my-libraries", getLibraries);
router.get("/:id/overview", getLibraryOverview);
router.patch("/update-library-details", updateLibrary);
router.post("/", createLibrary);

export default router;
