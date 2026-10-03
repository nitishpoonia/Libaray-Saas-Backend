import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  newTotpSecret,
  stepAt,
  totpAt,
  verifyTotp,
} from "../../src/lib/totp";

// RFC 6238 Appendix B: SHA-1 secret "12345678901234567890". The RFC lists 8-digit
// codes; a 6-digit code is the same number's last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const at = (seconds: number) => new Date(seconds * 1000);

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(totpAt(RFC_SECRET, stepAt(at(59)))).toBe("287082");
    expect(totpAt(RFC_SECRET, stepAt(at(1111111109)))).toBe("081804");
    expect(totpAt(RFC_SECRET, stepAt(at(1234567890)))).toBe("005924");
    expect(totpAt(RFC_SECRET, stepAt(at(2000000000)))).toBe("279037");
  });

  it("round-trips base32", () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("accepts the code from 30 seconds either side, and nothing older", () => {
    const now = at(1234567890);
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now, null)).toBeNull();
  });

  it("refuses a code that was already used", () => {
    const now = at(1234567890);
    const code = totpAt(RFC_SECRET, stepAt(now));
    const used = verifyTotp(RFC_SECRET, code, now, null);
    expect(verifyTotp(RFC_SECRET, code, now, used)).toBeNull();
  });

  it("encrypts secrets so only the key can read them", () => {
    const key = randomBytes(32).toString("base64");
    const stored = encryptSecret("JBSWY3DPEHPK3PXP", key);
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(stored, key)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret(stored, randomBytes(32).toString("base64"))).toThrow();
  });
});
