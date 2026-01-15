import dayjs from "dayjs";
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^\+91[6-9]\d{9}$/;

export function isEmail(value: string) {
  return emailRegex.test(value);
}

export function isPhone(value: string) {
  return phoneRegex.test(value);
}

export function validateIdentifier(value: string): "email" | "phone" {
  if (isEmail(value)) return "email";
  if (isPhone(value)) return "phone";
  throw new Error("Identifier must be a valid email or phone number");
}

export function formatTimeSingle(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

export function parseTime(time: string) {
  console.log("Time in request", time);

  const [hour, minute] = time.split(":").map(Number);
  console.log("Hour", "minute", hour, minute);

  const base = new Date();
  base.setHours(hour, minute, 0, 0);
  return base;
}

export function convertTimeToMinutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}
