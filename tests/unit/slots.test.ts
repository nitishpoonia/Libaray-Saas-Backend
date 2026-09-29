import { describe, expect, it } from "vitest";
import {
  formatSlot,
  parseTime,
  slotLength,
  slotsOverlap,
  type Slot,
} from "../../src/modules/memberships/slots";

const slot = (from: string, to: string): Slot => ({
  startMinute: parseTime(from)!,
  endMinute: parseTime(to)!,
});

describe("parseTime", () => {
  it("parses HH:MM", () => {
    expect(parseTime("00:00")).toBe(0);
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("23:59")).toBe(1439);
  });

  it("rejects anything else", () => {
    for (const bad of ["24:00", "9:30", "ab:cd", "12:60", "", "12:00:00"]) {
      expect(parseTime(bad)).toBeNull();
    }
  });
});

describe("slotsOverlap", () => {
  // The four cases the old function got wrong (REVIEW B1).
  it.each([
    ["22:00", "02:00", "10:00", "23:00"],
    ["22:00", "02:00", "01:00", "03:00"],
    ["21:00", "23:00", "22:00", "02:00"],
    ["09:00", "12:00", "22:00", "10:00"],
  ])("existing %s-%s overlaps new %s-%s", (a1, a2, b1, b2) => {
    expect(slotsOverlap(slot(a1, a2), slot(b1, b2))).toBe(true);
    expect(slotsOverlap(slot(b1, b2), slot(a1, a2))).toBe(true);
  });

  it("treats touching slots as free", () => {
    expect(slotsOverlap(slot("09:00", "12:00"), slot("12:00", "15:00"))).toBe(false);
    expect(slotsOverlap(slot("22:00", "02:00"), slot("02:00", "22:00"))).toBe(false);
  });

  it("finds normal overlaps and gaps", () => {
    expect(slotsOverlap(slot("09:00", "12:00"), slot("11:00", "13:00"))).toBe(true);
    expect(slotsOverlap(slot("09:00", "12:00"), slot("13:00", "15:00"))).toBe(false);
    expect(slotsOverlap(slot("22:00", "02:00"), slot("10:00", "20:00"))).toBe(false);
  });

  it("handles a slot ending exactly at midnight", () => {
    expect(slotsOverlap(slot("18:00", "00:00"), slot("23:00", "23:30"))).toBe(true);
    expect(slotsOverlap(slot("18:00", "00:00"), slot("00:00", "06:00"))).toBe(false);
  });

  it("treats equal start and end as a full day", () => {
    const fullDay = slot("06:00", "06:00");
    expect(slotLength(fullDay)).toBe(1440);
    expect(slotsOverlap(fullDay, slot("03:00", "04:00"))).toBe(true);
    expect(slotsOverlap(fullDay, slot("12:00", "13:00"))).toBe(true);
  });
});

describe("formatSlot", () => {
  it("formats back to HH:MM-HH:MM", () => {
    expect(formatSlot(slot("22:00", "02:00"))).toBe("22:00-02:00");
  });
});
