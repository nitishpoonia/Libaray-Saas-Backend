import dotenv from "dotenv";
import { z } from "zod";

// Load .env for local development. On Render the variables are injected directly,
// and dotenv never overrides a value that is already set.
dotenv.config({ quiet: true });

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

    // Render sets RENDER=true on every service. Used only to catch a missing NODE_ENV.
    RENDER: z.string().optional(),
  })
  // Without NODE_ENV the app would silently run in development mode on Render
  // (pretty logs, no production guards), so refuse to start instead.
  .refine((env) => !(env.RENDER === "true" && env.NODE_ENV !== "production"), {
    message: "Set NODE_ENV=production on Render",
    path: ["NODE_ENV"],
  })
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
