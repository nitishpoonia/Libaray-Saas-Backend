import express from "express";
import libraryOwnerRoutes from "./modules/auth/routes.js";
import libraryRoutes from "./modules/library/routes.js";
import studentRoutes from "./modules/student/routes.js";
const app = express();

app.use(express.json());
app.use("/owners", libraryOwnerRoutes);
app.use("/libraries", libraryRoutes);
app.use("/libraries", studentRoutes);
export default app;
