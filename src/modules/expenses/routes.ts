import express from "express";
import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import { createExpense, listAllExpenses } from "./controller";

const router = express.Router();

router.use(authMiddleware);
router.use(subscriptionCheck);
router.post("/:libraryId/add-expense", createExpense);
router.get("/:libraryId/list-all-expenses", listAllExpenses);
export default router;
