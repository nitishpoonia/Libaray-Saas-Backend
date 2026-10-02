/**
 * Creates a platform admin, or resets one's password and 2FA (lost phone).
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name"
 *   npm run admin:create -- --email you@example.com --reset
 *
 * On Render (Shell tab): node dist/scripts/createAdmin.js --email … --name …
 *
 * Prints a new random password and the 2FA secret ONCE. Add the secret to an
 * authenticator app (Google Authenticator, 1Password…) by scanning the otpauth link
 * as a QR code or typing the secret, then log in to the admin panel.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { prisma } from "../lib/prisma";
import { encryptSecret, newTotpSecret, otpauthUrl } from "../lib/totp";
import { adminConfig, hashAdminPassword } from "../modules/admin/auth";

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      reset: { type: "boolean", default: false },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Pass --email with a valid address");

  const config = adminConfig();
  const password = randomBytes(18).toString("base64url");
  const secret = newTotpSecret();
  const credentials = {
    passwordHash: await hashAdminPassword(password),
    totpSecret: encryptSecret(secret, config.totpKey),
    lastTotpStep: null,
  };

  if (values.reset) {
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (!existing) throw new Error(`No admin with email ${email}`);
    await prisma.$transaction([
      prisma.adminUser.update({ where: { id: existing.id }, data: { ...credentials, disabledAt: null } }),
      prisma.adminSession.updateMany({ where: { adminId: existing.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  } else {
    const name = values.name?.trim();
    if (!name) throw new Error("Pass --name for a new admin");
    if (await prisma.adminUser.findUnique({ where: { email } })) {
      throw new Error(`${email} is already an admin. Use --reset to issue a new password and 2FA secret.`);
    }
    await prisma.adminUser.create({ data: { email, name, ...credentials } });
  }

  console.log(
    [
      "",
      values.reset ? `Admin ${email} reset. All their sessions were ended.` : `Admin ${email} created.`,
      "",
      `Password:     ${password}`,
      `2FA secret:   ${secret}`,
      `2FA link:     ${otpauthUrl(secret, email)}`,
      "",
      "These are shown only now. Save the password in a password manager and add the",
      "2FA secret to an authenticator app before closing this window.",
      "",
    ].join("\n"),
  );
}

main()
  .then(() => 0)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
