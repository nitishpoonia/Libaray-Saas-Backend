import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { generalLimiter } from "./middleware/rateLimiters";
import { simulateLatency } from "./middleware/simulateLatency";
import authRoutes from "./modules/auth/routes";
import { billingRouter, billingWebhook } from "./modules/billing/routes";
import dashboardRoutes from "./modules/dashboard/routes";
import expenseRoutes from "./modules/expenses/routes";
import { libraryAccess, librariesRouter, libraryRouter } from "./modules/libraries/routes";
import meRoutes from "./modules/me/routes";
import { membershipPaymentsRouter, paymentsRouter } from "./modules/payments/routes";
import seatRoutes from "./modules/seats/routes";
import staffRoutes from "./modules/staff/routes";
import studentRoutes from "./modules/students/routes";
import { authMiddleware } from "./middleware/auth";

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

  // Razorpay signs the raw body, so its webhook is mounted before the JSON parser.
  app.use("/v1/billing/webhook", billingWebhook);

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

  app.use("/v1", apiV1());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Version 1 of the API. Installed apps keep calling /v1 after a breaking change
 * ships as /v2 (REVIEW API3).
 */
function apiV1() {
  const v1 = Router();

  v1.use("/auth", authRoutes);
  v1.use("/me", meRoutes);
  v1.use("/billing", billingRouter);
  v1.use("/libraries", authMiddleware, librariesRouter);

  // Everything inside one branch goes through the access check first (REVIEW S1).
  const branch = Router({ mergeParams: true });
  branch.use(authMiddleware, libraryAccess);
  branch.use("/", libraryRouter);
  branch.use("/dashboard", dashboardRoutes);
  branch.use("/seats", seatRoutes);
  branch.use("/students", studentRoutes);
  branch.use("/memberships", membershipPaymentsRouter);
  branch.use("/payments", paymentsRouter);
  branch.use("/expenses", expenseRoutes);
  branch.use("/staff", staffRoutes);
  v1.use("/libraries/:libraryId", branch);

  return v1;
}
