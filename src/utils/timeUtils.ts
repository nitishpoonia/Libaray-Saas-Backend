// utils/timeUtils.ts

interface TimeSlot {
  start_hour: number;
  start_minute: number;
  end_hour: number;
  end_minute: number;
  crosses_midnight: boolean;
}

/**
 * Converts time components to total minutes since midnight
 */
export const timeToMinutes = (hour: number, minute: number): number => {
  return hour * 60 + minute;
};

/**
 * Checks if two time slots overlap
 * Handles both regular slots and midnight-crossing slots
 */
export const doTimeSlotsOverlap = (
  slot1: TimeSlot,
  slot2: TimeSlot
): boolean => {
  const start1 = timeToMinutes(slot1.start_hour, slot1.start_minute);
  const end1 = timeToMinutes(slot1.end_hour, slot1.end_minute);
  const start2 = timeToMinutes(slot2.start_hour, slot2.start_minute);
  const end2 = timeToMinutes(slot2.end_hour, slot2.end_minute);

  // Case 1: Neither slot crosses midnight
  if (!slot1.crosses_midnight && !slot2.crosses_midnight) {
    return start1 < end2 && start2 < end1;
  }

  // Case 2: Slot1 crosses midnight, slot2 doesn't
  if (slot1.crosses_midnight && !slot2.crosses_midnight) {
    // Slot1 occupies [start1 to 24:00) and [00:00 to end1)
    // Check if slot2 overlaps with either part
    return start2 >= start1 || end2 <= end1 || start2 < end1;
  }

  // Case 3: Slot2 crosses midnight, slot1 doesn't
  if (!slot1.crosses_midnight && slot2.crosses_midnight) {
    return start1 >= start2 || end1 <= end2 || start1 < end2;
  }

  // Case 4: Both slots cross midnight - they always overlap
  return true;
};

/**
 * Formats time components to HH:MM string
 */
export const formatTime = (hour: number, minute: number): string => {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/**
 * Parses timing string (e.g., "10:00 - 18:00") into time components
 */
export const parseTimingString = (timing: string) => {
  const [start, end] = timing.split(" - ");
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);

  const crossesMidnight =
    endHour < startHour || (endHour === startHour && endMinute < startMinute);

  return {
    start_hour: startHour,
    start_minute: startMinute,
    end_hour: endHour,
    end_minute: endMinute,
    crosses_midnight: crossesMidnight,
  };
};

/**
 * Validates time components
 */
export const isValidTime = (hour: number, minute: number): boolean => {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
};
