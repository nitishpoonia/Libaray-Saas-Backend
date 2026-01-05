import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import express from "express";
import { createStudent, deleteStudent, getAllStudents } from "./controller";

const router = express.Router();
router.use(authMiddleware);
router.get("/student/:libraryId/all-students", getAllStudents);
router.use(subscriptionCheck);

router.post("/student/add-student", createStudent);
router.delete("/student/delete-student", deleteStudent);
export default router;
