import type { RequestHandler } from "express";

/**
 * Local-only: delays every request so the app can be tested against real-world latency.
 * Only mounted when SIMULATE_LATENCY_MS > 0, which the env config refuses in production.
 */
export const simulateLatency =
  (ms: number): RequestHandler =>
  (_req, _res, next) => {
    setTimeout(next, ms);
  };
