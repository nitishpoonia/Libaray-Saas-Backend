import { z } from "zod";
import { email, indianMobile, password, personName } from "../../lib/validation";

/** Owners log in with either an email or a mobile number. */
export const identifier = z
  .string()
  .trim()
  .min(1, "Enter your email or mobile number")
  .transform((value, ctx) => {
    if (value.includes("@")) {
      const parsed = email.safeParse(value);
      if (parsed.success) return { email: parsed.data } as const;
    } else {
      const parsed = indianMobile.safeParse(value);
      if (parsed.success) return { phone: parsed.data } as const;
    }
    ctx.addIssue({ code: "custom", message: "Enter a valid email or 10-digit mobile number" });
    return z.NEVER;
  });

export const signupBody = z.object({
  name: personName,
  identifier,
  password,
});

export const loginBody = z.object({
  identifier,
  password: z.string().min(1).max(72),
});

export const refreshBody = z.object({
  refreshToken: z.string().min(1),
});

export const logoutBody = z.object({
  /** The device's push token, so this phone stops receiving this user's notifications. */
  deviceToken: z.string().min(1).optional(),
});
