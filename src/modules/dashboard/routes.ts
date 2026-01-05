import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { getLibraryOverview } from "./controller";
const router = express.Router();

router.use(authMiddleware);
router.get("/:libraryId/overview", getLibraryOverview);
export default router;
