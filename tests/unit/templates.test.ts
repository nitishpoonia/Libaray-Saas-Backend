import { describe, expect, it } from "vitest";
import { cancellationWarning, dailyDigest, overdueNotice } from "../../src/modules/notifications/templates";

const period = {
  studentName: "Ravi",
  libraryName: "Focus Library",
  seatLabel: "12",
  startMinute: 1320,
  endMinute: 120,
  endDate: "2026-01-10",
  graceEndsOn: "2026-01-16",
  pendingAmount: 0,
};

describe("notice texts", () => {
  it("fits the overdue notice in two SMS parts", () => {
    const text = overdueNotice({ ...period, pendingAmount: 1500 });
    expect(text).toBe(
      "Focus Library: Hi Ravi, your membership (seat 12, 22:00-02:00) ended on 10 Jan. " +
        "Your seat is held until 16 Jan. Renew to keep it. Pending fees: Rs 1,500.",
    );
    expect(text.length).toBeLessThanOrEqual(306);
  });

  it("names the cancellation date", () => {
    expect(cancellationWarning({ ...period, cancelDate: "2026-01-17" })).toContain("tomorrow (17 Jan)");
  });

  it("sends no digest on a quiet day", () => {
    expect(
      dailyDigest({
        libraryName: "Focus Library",
        cancelTomorrow: [],
        newlyCancelled: [],
        overdueCount: 0,
        endingSoonCount: 0,
        endingSoonFees: 0,
        pendingFees: 0,
      }),
    ).toBeNull();
  });
});
