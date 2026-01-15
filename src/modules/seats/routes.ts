import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import { getAllAvailableSeats } from "./controller";

const router = express.Router();
router.use(authMiddleware);

router.post("/:libraryId/available-seats", getAllAvailableSeats);

export default router;
