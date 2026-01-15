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
export function hasTimeOverlap(
  newStartMinutes: number,
  newEndMinutes: number,
  existingStart: { hour: number; minute: number },
  existingEnd: { hour: number; minute: number },
  crossesMidnight: boolean
): boolean {
  const existingStartMinutes = existingStart.hour * 60 + existingStart.minute;
  const existingEndMinutes = existingEnd.hour * 60 + existingEnd.minute;

  // Handle midnight crossing cases
  if (crossesMidnight) {
    // Existing booking crosses midnight (e.g., 22:00 to 02:00)
    // This means it occupies: 22:00-23:59 AND 00:00-02:00
    // New slot overlaps if it's either in evening portion OR morning portion
    return (
      newStartMinutes >= existingStartMinutes || // New starts in evening (after 22:00)
      newEndMinutes <= existingEndMinutes // New ends in morning (before 02:00)
    );
  }

  // Standard overlap check
  // Two time ranges overlap if:
  // - One starts before the other ends AND
  // - One ends after the other starts
  //
  // Or simpler: They DON'T overlap only if:
  // - new ends before existing starts (10:30 <= 11:00) OR
  // - new starts after existing ends (09:00 >= 20:00)

  const noOverlap =
    newEndMinutes <= existingStartMinutes ||
    newStartMinutes >= existingEndMinutes;
  return !noOverlap;
}
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
