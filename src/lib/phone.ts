/**
 * Indian mobile numbers are stored in E.164 form (+91 followed by 10 digits
 * starting with 6-9). Accepts "9876543210", "+91 98765 43210", "09876543210".
 * Returns null when the input isn't a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return match ? `+91${match[1]}` : null;
}
