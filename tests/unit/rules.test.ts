import { describe, expect, it } from "vitest";
import {
  daysRemaining,
  graceEndsOn,
  isCancellationWarningDay,
  nextLifecycleChange,
  periodEnd,
} from "../../src/modules/memberships/rules";

describe("grace period (7 days, ends 10 Jan)", () => {
  const end = "2026-01-10";
  const grace = graceEndsOn(end, 7);

  it("keeps the seat until day 6", () => {
    expect(grace).toBe("2026-01-16");
  });

  it("warns on day 6", () => {
    expect(isCancellationWarningDay(grace, "2026-01-16")).toBe(true);
    expect(isCancellationWarningDay(grace, "2026-01-15")).toBe(false);
  });

  it("walks ACTIVE -> OVERDUE -> CANCELLED", () => {
    const active = { status: "ACTIVE" as const, endDate: end, graceEndsOn: null, renewed: false };
    expect(nextLifecycleChange(active, "2026-01-10", 7)).toBeNull();
    expect(nextLifecycleChange(active, "2026-01-11", 7)).toEqual({
      to: "OVERDUE",
      graceEndsOn: "2026-01-16",
    });

    const overdue = { ...active, status: "OVERDUE" as const, graceEndsOn: grace };
    expect(nextLifecycleChange(overdue, "2026-01-16", 7)).toBeNull();
    expect(nextLifecycleChange(overdue, "2026-01-17", 7)).toEqual({ to: "CANCELLED" });
  });

  it("completes a period that was renewed", () => {
    const renewed = { status: "ACTIVE" as const, endDate: end, graceEndsOn: null, renewed: true };
    expect(nextLifecycleChange(renewed, "2026-01-11", 7)).toEqual({ to: "COMPLETED" });
  });

  it("cancels directly when the job missed the whole grace period", () => {
    const active = { status: "ACTIVE" as const, endDate: end, graceEndsOn: null, renewed: false };
    expect(nextLifecycleChange(active, "2026-01-20", 7)).toEqual({ to: "CANCELLED" });
  });
});

describe("period helpers", () => {
  it("counts the start day in the period", () => {
    expect(periodEnd("2026-01-01", 30)).toBe("2026-01-30");
    expect(periodEnd("2026-01-01", 1)).toBe("2026-01-01");
  });

  it("counts today in the days remaining", () => {
    expect(daysRemaining("2026-01-30", "2026-01-30")).toBe(1);
    expect(daysRemaining("2026-01-30", "2026-01-01")).toBe(30);
    expect(daysRemaining("2026-01-30", "2026-02-02")).toBe(0);
  });
});
