import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/** Every error response in the API has this one shape. */
function toBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(toBody("ROUTE_NOT_FOUND", `No route for ${req.method} ${req.path}`));
};

// Express 5 forwards errors thrown in async handlers here automatically,
// so controllers don't need their own try/catch.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(toBody(err.code, err.message, err.details));
    return;
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json(toBody("VALIDATION_ERROR", "Invalid request", details));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint (e.g. email already registered)
    if (err.code === "P2002") {
      res.status(409).json(toBody("CONFLICT", "A record with these details already exists"));
      return;
    }
    // Record to update/delete not found
    if (err.code === "P2025") {
      res.status(404).json(toBody("NOT_FOUND", "Record not found"));
      return;
    }
  }

  // Malformed JSON body
  if (err?.type === "entity.parse.failed") {
    res.status(400).json(toBody("INVALID_JSON", "Request body is not valid JSON"));
    return;
  }

  // Anything else is a bug. Log it with the request id; never send internals to the client.
  (req.log ?? logger).error({ err }, "Unhandled error");
  res.status(500).json(toBody("INTERNAL_ERROR", "Something went wrong"));
};
