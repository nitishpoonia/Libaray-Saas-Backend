import dotenv from "dotenv";
dotenv.config();
import app from "./app";
import { startMembershipExpiryJob } from "./jobs/membershipExpiry";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startMembershipExpiryJob();
});
