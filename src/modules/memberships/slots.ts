/**
 * Daily time slots, stored as minutes from midnight (0-1439).
 *
 *   09:00-17:00  ->  start 540,  end 1020   (normal)
 *   22:00-02:00  ->  start 1320, end 120    (crosses midnight: end <= start)
 *   06:00-06:00  ->  start 360,  end 360    (full 24 hours)
 *
 * To compare two slots, each one is split into plain ranges on a 0-1440 line:
 *   09:00-17:00 -> [540, 1020)
 *   22:00-02:00 -> [1320, 1440) and [0, 120)
 * Two slots overlap if any range of one overlaps any range of the other.
 */
export type Slot = { startMinute: number; endMinute: number };

const DAY = 24 * 60;

export function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatSlot(slot: Slot): string {
  return `${formatTime(slot.startMinute)}-${formatTime(slot.endMinute)}`;
}

export function crossesMidnight(slot: Slot): boolean {
  return slot.endMinute <= slot.startMinute;
}

/** Splits a slot into half-open [from, to) ranges within one day. */
export function toRanges(slot: Slot): Array<[number, number]> {
  if (!crossesMidnight(slot)) return [[slot.startMinute, slot.endMinute]];
  const ranges: Array<[number, number]> = [[slot.startMinute, DAY]];
  if (slot.endMinute > 0) ranges.push([0, slot.endMinute]);
  return ranges;
}

export function slotsOverlap(a: Slot, b: Slot): boolean {
  for (const [aFrom, aTo] of toRanges(a)) {
    for (const [bFrom, bTo] of toRanges(b)) {
      if (aFrom < bTo && bFrom < aTo) return true;
    }
  }
  return false;
}

/** Length of the slot in minutes (a full-day slot is 1440). */
export function slotLength(slot: Slot): number {
  return toRanges(slot).reduce((sum, [from, to]) => sum + (to - from), 0);
}
