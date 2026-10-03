import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { generalLimiter } from "./middleware/rateLimiters";
import { simulateLatency } from "./middleware/simulateLatency";
import libraryOwnerRoutes from "./modules/auth/routes";
import dashboardRoutes from "./modules/dashboard/routes";
import expenseRoutes from "./modules/expenses/routes";
import libraryRoutes from "./modules/library/routes";
import notificationRoutes from "./modules/notification/routes";
import seatRoutes from "./modules/seats/routes";
import studentRoutes from "./modules/student/routes";
import profileRoutes from "./modules/userProfile/route";

export function createApp() {
  const app = express();

  // Render sits in front of the app. Without this, every request looks like it comes
  // from the proxy's IP and the rate limiter treats all users as one.
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet());

  // One request id per request, reused from the proxy header when present,
  // attached to every log line and returned so a user report can be traced.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === "/health" },
    }),
  );

  app.use(express.json({ limit: "100kb" }));

  if (env.SIMULATE_LATENCY_MS > 0) {
    app.use(simulateLatency(env.SIMULATE_LATENCY_MS));
  }

  // Render health check: confirms the process is up and the database answers.
  app.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  });

  app.use(generalLimiter);

  app.use("/owners", libraryOwnerRoutes);
  app.use("/libraries", libraryRoutes);
  app.use("/libraries", studentRoutes);
  app.use("/seats", seatRoutes);
  app.use("/libraries", expenseRoutes);
  app.use("/libraries", dashboardRoutes);
  app.use("/profile", profileRoutes);
  app.use("/notification", notificationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
