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

  it("needs the webhook secret whenever Razorpay keys are set", () => {
    const keys = { RAZORPAY_KEY_ID: "rzp_live_x", RAZORPAY_KEY_SECRET: "secret" };
    expect(() => parseEnv({ ...valid, ...keys })).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    expect(parseEnv({ ...valid, ...keys, RAZORPAY_WEBHOOK_SECRET: "whsec" }).RAZORPAY_KEY_ID).toBe("rzp_live_x");
    // Empty values, as copied from .env.example, mean billing is off.
    expect(() => parseEnv({ ...valid, RAZORPAY_KEY_ID: "", RAZORPAY_WEBHOOK_SECRET: "" })).not.toThrow();
  });

  it("turns the admin API on only with both secrets, distinct from JWT_SECRET", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const secret = "a".repeat(40);
    expect(() => parseEnv({ ...valid, ADMIN_JWT_SECRET: secret })).toThrow(/ADMIN_TOTP_KEY/);
    expect(() => parseEnv({ ...valid, ADMIN_JWT_SECRET: valid.JWT_SECRET, ADMIN_TOTP_KEY: key })).toThrow(
      /must differ/,
    );
    expect(() => parseEnv({ ...valid, ADMIN_JWT_SECRET: secret, ADMIN_TOTP_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(parseEnv({ ...valid, ADMIN_JWT_SECRET: secret, ADMIN_TOTP_KEY: key }).ADMIN_SESSION_HOURS).toBe(8);
    // Empty values, as copied from .env.example, mean "off".
    expect(parseEnv({ ...valid, ADMIN_JWT_SECRET: "", ADMIN_TOTP_KEY: "" }).ADMIN_JWT_SECRET).toBeUndefined();
  });

  it("reads CORS_ORIGINS as a list", () => {
    expect(parseEnv({ ...valid, CORS_ORIGINS: " https://a.in , https://b.in," }).CORS_ORIGINS).toEqual([
      "https://a.in",
      "https://b.in",
    ]);
    expect(parseEnv(valid).CORS_ORIGINS).toEqual([]);
  });

  it("refuses simulated latency in production", () => {
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: "production", SIMULATE_LATENCY_MS: "2000" }),
    ).toThrow(/SIMULATE_LATENCY_MS/);
  });
});
