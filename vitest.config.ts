import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5432/library_saas_test",
      JWT_SECRET: "test-secret-test-secret-test-secret-123",
      ADMIN_JWT_SECRET: "test-admin-secret-test-admin-secret-456",
      ADMIN_TOTP_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      CORS_ORIGINS: "https://admin.example.test",
    },
  },
});
