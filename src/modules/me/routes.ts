import { Router, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import { sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { email, indianMobile, password, personName } from "../../lib/validation";
import { authMiddleware } from "../../middleware/auth";
import { requireUser } from "../../middleware/libraryAccess";
import { hashPassword, revokeAllSessions } from "../auth/service";
import { listAccessibleLibraries } from "../libraries/service";

// The logged-in user's own account: profile, password, push devices.

const updateProfileBody = z
  .object({
    name: personName.optional(),
    email: email.optional(),
    phone: indianMobile.optional(),
    notificationsEnabled: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), "Nothing to update");

const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(72), newPassword: password })
  .refine((b) => b.currentPassword !== b.newPassword, {
    message: "New password must be different",
    path: ["newPassword"],
  });

const registerDeviceBody = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["ANDROID", "IOS"]),
});

async function getMe(req: Request, res: Response) {
  const { id } = requireUser(req);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      notificationsEnabled: true,
      ownedOrganization: {
        select: {
          id: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          billedBranches: true,
        },
      },
    },
  });
  const { ownedOrganization, ...profile } = user;
  sendData(res, {
    user: profile,
    organization: ownedOrganization,
    libraries: await listAccessibleLibraries(id),
  });
}

async function updateMe(req: Request, res: Response) {
  const { id } = requireUser(req);
  const body = updateProfileBody.parse(req.body);
  // A taken email or phone surfaces as a 409 from the error handler (REVIEW B18).
  const user = await prisma.user.update({
    where: { id },
    data: body,
    select: { id: true, name: true, email: true, phone: true, notificationsEnabled: true },
  });
  sendData(res, user);
}

async function changePassword(req: Request, res: Response) {
  const { id, sessionId } = requireUser(req);
  const body = changePasswordBody.parse(req.body);

  const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
    throw badRequest("Current password is incorrect", "WRONG_PASSWORD");
  }

  await prisma.user.update({
    where: { id },
    data: { passwordHash: await hashPassword(body.newPassword) },
  });
  // Every other device has to log in again with the new password (REVIEW S7).
  await revokeAllSessions(id, sessionId);
  res.status(204).end();
}

async function registerDevice(req: Request, res: Response) {
  const { id } = requireUser(req);
  const { token, platform } = registerDeviceBody.parse(req.body);
  // A token belongs to one phone. If someone else logged in on this phone before,
  // it moves to the current user.
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform, userId: id },
    update: { userId: id, platform, lastSeenAt: new Date() },
  });
  res.status(204).end();
}

async function removeDevice(req: Request, res: Response) {
  const { id } = requireUser(req);
  await prisma.deviceToken.deleteMany({ where: { token: String(req.params.token), userId: id } });
  res.status(204).end();
}

const router = Router();
router.use(authMiddleware);
router.get("/", getMe);
router.patch("/", updateMe);
router.post("/password", changePassword);
router.post("/devices", registerDevice);
router.delete("/devices/:token", removeDevice);

export default router;
