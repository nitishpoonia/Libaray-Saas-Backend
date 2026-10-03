import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { notFound } from "../src/lib/errors";
import { errorHandler, notFoundHandler } from "../src/middleware/errorHandler";

function appThatThrows(error: unknown) {
  const app = express();
  app.use(express.json());
  app.post("/boom", async () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("turns an AppError into its status and code", async () => {
    const res = await request(appThatThrows(notFound("Student not found"))).post("/boom");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Student not found" } });
  });

  it("turns a ZodError into a 400 with field details", async () => {
    const result = z.object({ name: z.string() }).safeParse({});
    const res = await request(appThatThrows(result.error)).post("/boom");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("name");
  });

  it("hides unknown errors behind a generic 500", async () => {
    const res = await request(appThatThrows(new Error("db password is hunter2"))).post("/boom");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });

  it("answers malformed JSON with 400", async () => {
    const res = await request(appThatThrows(null))
      .post("/boom")
      .set("content-type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("answers unknown routes with 404", async () => {
    const res = await request(appThatThrows(null)).get("/missing");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
