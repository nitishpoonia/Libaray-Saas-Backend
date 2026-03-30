import { authMiddleware } from "../../middleware/auth";
import { subscriptionCheck } from "../../middleware/subscriptionCheck";
import express from "express";
import {
  addPayment,
  createStudent,
  deleteStudent,
  getAllStudents,
  getStudentDetails,
  listExpiringSoonStudents,
  listOverdueStudents,
  renewMembership,
  updateStudentDetails,
} from "./controller";

const router = express.Router();
router.use(authMiddleware);
router.get("/student/:libraryId/all-students", getAllStudents);
router.get("/student/:libraryId/:studentId", getStudentDetails);
router.put(
  "/student/:libraryId/:studentId",
  subscriptionCheck,
  updateStudentDetails,
);
router.get("/student/overdue", listOverdueStudents);
router.get("/student/expiringSoon", listExpiringSoonStudents);
router.post("/student/add-student", subscriptionCheck, createStudent);
router.post("/student/add-payment", subscriptionCheck, addPayment);
router.post(
  "/student/:libraryId/renew-membership",
  subscriptionCheck,
  renewMembership,
);
router.delete("/student/delete-student", subscriptionCheck, deleteStudent);
export default router;
