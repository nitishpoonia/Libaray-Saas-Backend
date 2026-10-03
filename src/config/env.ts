import dotenv from "dotenv";
import { z } from "zod";

// Load .env for local development. On Render the variables are injected directly,
// and dotenv never overrides a value that is already set.
dotenv.config({ quiet: true });

/** An optional value where an empty string (as copied from .env.example) means "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    DATABASE_URL: z.string().url(),

    // At least 32 characters so the signing key can't be brute-forced.
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    // Access tokens are short-lived; the app renews them with its refresh token.
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Free trial for a new owner account.
    TRIAL_DAYS: z.coerce.number().int().positive().default(14),

    // Number of proxies in front of the app. Render has one.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // Local-only: delay every request to feel real-world latency. Refused in production below.
    SIMULATE_LATENCY_MS: z.coerce.number().int().min(0).default(0),

    // How students get overdue notices. The provider is plugged in once an SMS / WhatsApp
    // account (and its DLT-registered templates) exists; until then notices are logged
    // and recorded as SKIPPED.
    STUDENT_NOTICE_CHANNEL: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
    TEXT_PROVIDER: z.enum(["none"]).default("none"),

    // Razorpay (owner subscriptions). Without keys, billing endpoints answer 503.
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    // Prices in paise (₹999 = 99900). Yearly is billed as 10 months.
    PLAN_BASE_MONTHLY_PAISE: z.coerce.number().int().positive().default(99_900),
    PLAN_EXTRA_BRANCH_MONTHLY_PAISE: z.coerce.number().int().positive().default(49_900),

    // Firebase service account JSON as a single-line string. Optional: without it,
    // push notifications are skipped and logged instead.
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),

    // Platform admin API (/admin/v1). Both must be set to turn it on; without them it answers 503.
    // A different secret from JWT_SECRET, so a customer token can never pass as an admin one.
    ADMIN_JWT_SECRET: optional(z.string().min(32, "ADMIN_JWT_SECRET must be at least 32 characters")),
    // 32 random bytes, base64 (openssl rand -base64 32). Encrypts admins' 2FA secrets in the database.
    ADMIN_TOTP_KEY: optional(
      z.string().refine((v) => Buffer.from(v, "base64").length === 32, "ADMIN_TOTP_KEY must be 32 bytes, base64"),
    ),
    ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),

    // Browser apps allowed to call the API (owner dashboard, admin panel), comma-separated:
    // https://app.example.in,https://admin.example.in. The mobile app doesn't need CORS.
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),

    // Render sets RENDER=true on every service. Used only to catch a missing NODE_ENV.
    RENDER: z.string().optional(),
  })
  // Without NODE_ENV the app would silently run in development mode on Render
  // (pretty logs, no production guards), so refuse to start instead.
  .refine((env) => !(env.RENDER === "true" && env.NODE_ENV !== "production"), {
    message: "Set NODE_ENV=production on Render",
    path: ["NODE_ENV"],
  })
  .refine((env) => Boolean(env.ADMIN_JWT_SECRET) === Boolean(env.ADMIN_TOTP_KEY), {
    message: "Set both ADMIN_JWT_SECRET and ADMIN_TOTP_KEY, or neither",
    path: ["ADMIN_TOTP_KEY"],
  })
  .refine((env) => env.ADMIN_JWT_SECRET !== env.JWT_SECRET, {
    message: "ADMIN_JWT_SECRET must differ from JWT_SECRET",
    path: ["ADMIN_JWT_SECRET"],
  })
  // With keys but no webhook secret every webhook fails its signature check, and
  // Razorpay quietly disables the webhook after repeated failures.
  .refine(
    (env) => !env.RAZORPAY_KEY_ID || (Boolean(env.RAZORPAY_KEY_SECRET) && Boolean(env.RAZORPAY_WEBHOOK_SECRET)),
    {
      message: "RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when RAZORPAY_KEY_ID is set",
      path: ["RAZORPAY_WEBHOOK_SECRET"],
    },
  )
  .refine((env) => !(env.NODE_ENV === "production" && env.SIMULATE_LATENCY_MS > 0), {
    message: "SIMULATE_LATENCY_MS must be 0 in production",
    path: ["SIMULATE_LATENCY_MS"],
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Fail at boot, not when the first user hits a route that needs the value.
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
export const isProduction = env.NODE_ENV === "production";
