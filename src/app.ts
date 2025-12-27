import express from "express";
import libraryOwnerRoutes from "./modules/libraryOwner/routes.js";
import libraryRoutes from "./modules/library/routes.js";
const app = express();

app.use(express.json());
app.use("/owners", libraryOwnerRoutes);
app.use("/libraries", libraryRoutes);
export default app;
