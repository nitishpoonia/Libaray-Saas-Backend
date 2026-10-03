import type { Request, RequestHandler } from "express";
import { forbidden, notFound, unauthorized } from "../lib/errors";
import { prisma } from "../lib/prisma";
import type { AuthUser, LibraryAccess, LibraryRole } from "../types/express";

/**
 * The tenant boundary (REVIEW S1). Every route under /libraries/:libraryId runs this.
 *
 * It loads the branch and works out the caller's role in it:
 *   - OWNER   if the caller owns the branch's organization
 *   - MANAGER or STAFF if the caller is assigned to the branch
 * Anyone else gets 404, the same answer as for a branch that doesn't exist, so ids
 * of other businesses' branches can't be probed.
 *
 * Handlers then filter every query by req.access.library.id, including lookups
 * by student, membership or payment id.
 */
export const libraryAccess: RequestHandler = async (req, _res, next) => {
  const user = requireUser(req);
  const libraryId = Number(req.params.libraryId);
  if (!Number.isInteger(libraryId) || libraryId <= 0) throw notFound("Library not found");

  const library = await prisma.library.findUnique({
    where: { id: libraryId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      timezone: true,
      gracePeriodDays: true,
      organization: { select: { ownerId: true } },
      staff: { where: { userId: user.id }, select: { role: true } },
    },
  });

  if (!library) throw notFound("Library not found");

  let role: LibraryRole | null = null;
  if (library.organization.ownerId === user.id) role = "OWNER";
  else if (library.staff[0]) role = library.staff[0].role;

  if (!role) throw notFound("Library not found");

  const { organization: _org, staff: _staff, ...libraryFields } = library;
  req.access = { role, library: libraryFields };
  next();
};

const rank: Record<LibraryRole, number> = { STAFF: 1, MANAGER: 2, OWNER: 3 };

/**
 * Allows the route for `minimum` and every role above it:
 *   requireRole("MANAGER") -> MANAGER and OWNER
 */
export const requireRole =
  (minimum: LibraryRole): RequestHandler =>
  (req, _res, next) => {
    const { role } = requireAccess(req);
    if (rank[role] < rank[minimum]) {
      throw forbidden("Your role can't do this", "INSUFFICIENT_ROLE");
    }
    next();
  };

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAccess(req: Request): LibraryAccess {
  if (!req.access) throw new Error("libraryAccess middleware did not run for this route");
  return req.access;
}
