import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import { createExpense, listAllExpenses } from "./controller";

const router = express.Router();

router.use(authMiddleware);
router.get("/:libraryId/list-all-expenses", listAllExpenses);
router.post("/:libraryId/add-expense", subscriptionCheck, createExpense);
export default router;
