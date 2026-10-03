import { env } from "./config/env";
import { createApp } from "./app";
import { startMembershipExpiryJob } from "./jobs/membershipExpiry";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server started");
  startMembershipExpiryJob();
});

// Render sends SIGTERM on every deploy. Finish in-flight requests, then close the DB pool.
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Don't hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
