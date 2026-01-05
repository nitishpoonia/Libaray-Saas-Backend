const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRegex = /^\+91[6-9]\d{9}$/;

function isEmail(value: string) {
  return emailRegex.test(value);
}

function isPhone(value: string) {
  return phoneRegex.test(value);
}

export function validateIdentifier(value: string): "email" | "phone" {
  if (isEmail(value)) return "email";
  if (isPhone(value)) return "phone";
  throw new Error("Identifier must be a valid email or phone number");
}

export function formatTime(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}
