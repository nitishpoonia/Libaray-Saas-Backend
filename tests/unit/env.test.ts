import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  JWT_SECRET: "x".repeat(32),
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.SIMULATE_LATENCY_MS).toBe(0);
  });

  it("rejects a short JWT secret", () => {
    expect(() => parseEnv({ ...valid, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("rejects a missing database URL", () => {
    expect(() => parseEnv({ JWT_SECRET: valid.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("refuses to run on Render without NODE_ENV=production", () => {
    expect(() => parseEnv({ ...valid, RENDER: "true" })).toThrow(/NODE_ENV=production/);
    expect(parseEnv({ ...valid, RENDER: "true", NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("refuses simulated latency in production", () => {
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: "production", SIMULATE_LATENCY_MS: "2000" }),
    ).toThrow(/SIMULATE_LATENCY_MS/);
  });
});
