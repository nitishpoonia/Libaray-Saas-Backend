import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { getDashboard } from "./controller";
const router = express.Router();

router.use(authMiddleware);
router.get("/:libraryId/dashboard-overview", getDashboard);
export default router;
