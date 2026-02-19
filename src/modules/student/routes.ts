import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import express from "express";
import { createStudent, deleteStudent, getAllStudents } from "./controller";

const router = express.Router();
router.use(authMiddleware);
router.get("/student/:libraryId/all-students", getAllStudents);

router.post("/student/add-student", subscriptionCheck, createStudent);
router.delete("/student/delete-student", subscriptionCheck, deleteStudent);
export default router;
