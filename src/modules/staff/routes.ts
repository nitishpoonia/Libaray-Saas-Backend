import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { conflict, notFound } from "../../lib/errors";
import { sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { email, id, indianMobile, password, personName } from "../../lib/validation";
import { requireAccess, requireRole } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";
import { hashPassword } from "../auth/service";

/**
 * Branch staff logins. Only the owner manages staff.
 * A staff member logs in with their mobile number and the password the owner set,
 * and can change it from their profile.
 */

const role = z.enum(["MANAGER", "STAFF"]);

const addBody = z.object({
  name: personName,
  phone: indianMobile,
  email: email.optional(),
  /** Required for a new login; ignored if this mobile number already has an account. */
  password: password.optional(),
  role,
});

const staffSelect = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, name: true, phone: true, email: true } },
} as const;

async function list(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const staff = await prisma.libraryStaff.findMany({
    where: { libraryId: library.id },
    select: staffSelect,
    orderBy: { createdAt: "asc" },
  });
  sendData(res, staff);
}

async function add(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const body = addBody.parse(req.body);

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: library.organizationId },
    select: { ownerId: true },
  });

  let user = await prisma.user.findUnique({ where: { phone: body.phone }, select: { id: true } });
  if (user?.id === org.ownerId) throw conflict("The owner already has full access", "ALREADY_OWNER");

  if (!user) {
    if (!body.password) {
      throw conflict("Set a password for this new login", "PASSWORD_REQUIRED");
    }
    user = await prisma.user.create({
      data: {
        name: body.name,
        phone: body.phone,
        email: body.email,
        passwordHash: await hashPassword(body.password),
      },
      select: { id: true },
    });
  }

  const existing = await prisma.libraryStaff.findUnique({
    where: { libraryId_userId: { libraryId: library.id, userId: user.id } },
  });
  if (existing) throw conflict("This person already has access to this branch", "ALREADY_STAFF");

  const staff = await prisma.libraryStaff.create({
    data: { libraryId: library.id, userId: user.id, role: body.role },
    select: staffSelect,
  });
  sendData(res, staff, undefined, 201);
}

async function changeRole(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const staffId = id.parse(req.params.staffId);
  const body = z.object({ role }).parse(req.body);
  const { count } = await prisma.libraryStaff.updateMany({
    where: { id: staffId, libraryId: library.id },
    data: { role: body.role },
  });
  if (!count) throw notFound("Staff member not found");
  const staff = await prisma.libraryStaff.findUniqueOrThrow({ where: { id: staffId }, select: staffSelect });
  sendData(res, staff);
}

async function remove(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const staffId = id.parse(req.params.staffId);
  const { count } = await prisma.libraryStaff.deleteMany({
    where: { id: staffId, libraryId: library.id },
  });
  if (!count) throw notFound("Staff member not found");
  res.status(204).end();
}

const router = Router({ mergeParams: true });
router.use(requireRole("OWNER"));
router.get("/", list);
router.post("/", requireActiveSubscription, add);
router.patch("/:staffId", changeRole);
router.delete("/:staffId", remove);

export default router;
