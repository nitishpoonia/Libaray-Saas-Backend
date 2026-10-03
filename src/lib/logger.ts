import pino from "pino";
import { env, isProduction } from "../config/env";

// Anything matching these paths is replaced with "[REDACTED]" before it's written.
// Covers request headers, request bodies and any object we log by hand.
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.password_hash",
  "*.currentPassword",
  "*.newPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.DATABASE_URL",
  "*.JWT_SECRET",
];

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  // Readable output locally, JSON in production so Render's log search can filter by field.
  transport: isProduction
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});
