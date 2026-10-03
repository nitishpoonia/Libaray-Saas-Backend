import { describe, expect, it } from "vitest";
import {
  cancellationWarning,
  dailyDigest,
  overdueNotice,
  TEXT_TEMPLATES,
} from "../../src/modules/notifications/templates";

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
    const message = overdueNotice({ ...period, pendingAmount: 1500 });
    expect(message.template).toBe("OVERDUE_NOTICE_WITH_DUES");
    expect(message.text).toBe(
      "Focus Library: Hi Ravi, your membership (seat 12, 22:00-02:00) ended on 10 Jan. " +
        "Your seat is held until 16 Jan. Renew to keep it. Pending fees: Rs 1,500.",
    );
    expect(message.text.length).toBeLessThanOrEqual(306);
  });

  it("uses the template without dues when nothing is pending", () => {
    const message = overdueNotice(period);
    expect(message.template).toBe("OVERDUE_NOTICE");
    expect(message.text).not.toContain("Pending fees");
  });

  it("names the cancellation date", () => {
    const message = cancellationWarning({ ...period, cancelDate: "2026-01-17" });
    expect(message.template).toBe("CANCELLATION_WARNING");
    expect(message.text).toContain("tomorrow (17 Jan)");
  });

  it("fills every DLT placeholder, in order", () => {
    const messages = [
      overdueNotice(period),
      overdueNotice({ ...period, pendingAmount: 200 }),
      cancellationWarning({ ...period, cancelDate: "2026-01-17" }),
    ];
    for (const m of messages) {
      expect(m.text).not.toContain("{#var#}");
      // Re-filling the registered template with the values gives back the same text.
      let i = 0;
      expect(TEXT_TEMPLATES[m.template].replace(/\{#var#\}/g, () => m.vars[i++]!)).toBe(m.text);
    }
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
