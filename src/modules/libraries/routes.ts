import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { sendData } from "../../lib/http";
import { prisma } from "../../lib/prisma";
import { libraryAccess, requireAccess, requireRole, requireUser } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";
import { syncLifecycle } from "../memberships/lifecycle";
import { createLibrary, listAccessibleLibraries } from "./service";

const createBody = z.object({
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().min(2).max(300),
  seatCount: z.coerce.number().int().min(1).max(1000),
  gracePeriodDays: z.coerce.number().int().min(1).max(30).optional(),
});

const updateBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    address: z.string().trim().min(2).max(300).optional(),
    gracePeriodDays: z.coerce.number().int().min(1).max(30).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to update");

async function list(req: Request, res: Response) {
  sendData(res, await listAccessibleLibraries(requireUser(req).id));
}

async function create(req: Request, res: Response) {
  const input = createBody.parse(req.body);
  const library = await createLibrary(requireUser(req).id, input);
  sendData(res, library, undefined, 201);
}

async function get(req: Request, res: Response) {
  const { library, role } = requireAccess(req);
  await syncLifecycle(library);
  const [details, seatCount, studentCount] = await Promise.all([
    prisma.library.findUniqueOrThrow({ where: { id: library.id } }),
    prisma.seat.count({ where: { libraryId: library.id, archivedAt: null } }),
    prisma.student.count({ where: { libraryId: library.id, archivedAt: null } }),
  ]);
  const { nextReceiptSeq: _seq, ...rest } = details;
  sendData(res, { ...rest, role, seatCount, studentCount });
}

async function update(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const body = updateBody.parse(req.body);
  const updated = await prisma.library.update({ where: { id: library.id }, data: body });
  const { nextReceiptSeq: _seq, ...rest } = updated;
  sendData(res, rest);
}

/** Routes for the branch collection: /v1/libraries */
export const librariesRouter = Router();
librariesRouter.get("/", list);
librariesRouter.post("/", create);

/** Routes on one branch: /v1/libraries/:libraryId (after libraryAccess) */
export const libraryRouter = Router({ mergeParams: true });
libraryRouter.get("/", get);
libraryRouter.patch("/", requireRole("MANAGER"), requireActiveSubscription, update);

export { libraryAccess };
