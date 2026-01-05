import express from "express";
import libraryOwnerRoutes from "./modules/auth/routes.js";
import libraryRoutes from "./modules/library/routes.js";
import studentRoutes from "./modules/student/routes.js";
import seatRoutes from "./modules/seats/routes.js";
import expenseRoutes from "./modules/expenses/routes.js";
import dashboardRoutes from "./modules/dashboard/routes.js";
const app = express();

app.use(express.json());
app.use("/owners", libraryOwnerRoutes);
app.use("/libraries", libraryRoutes);
app.use("/libraries", studentRoutes);
app.use("/libraries", seatRoutes);
app.use("/libraries", expenseRoutes);
app.use("/libraries", dashboardRoutes);
export default app;
