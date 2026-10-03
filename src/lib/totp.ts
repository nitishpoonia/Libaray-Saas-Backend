import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238), the 6-digit codes authenticator apps show.
 * The app and the server share a secret; every 30 seconds both compute
 * HMAC-SHA1(secret, step number) and cut it down to 6 digits.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, as RFC 4226 recommends), base32 for authenticator apps. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const stepAt = (now: Date): number => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

/** The code for one 30-second step. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

/**
 * Checks a code against the current step and one step either side (phone clocks
 * drift). Returns the step it matched, or null. A step at or before `lastUsedStep`
 * is refused, so a code someone saw you type can't be used again.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** The link an authenticator app reads from a QR code. */
export function otpauthUrl(secret: string, account: string, issuer = "Library SaaS Admin"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Encryption at rest ─────────────────────────────────────────────────────

/** AES-256-GCM with a random IV. Stored as "v1.<iv>.<tag>.<ciphertext>", each base64. */
export function encryptSecret(plain: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), encrypted].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(".");
}

export function decryptSecret(stored: string, keyBase64: string): string {
  const [version, iv, tag, encrypted] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
