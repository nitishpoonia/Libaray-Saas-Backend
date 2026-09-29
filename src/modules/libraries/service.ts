import { forbidden } from "../../lib/errors";
import { assertCanAddBranch } from "../billing/service";
import { prisma } from "../../lib/prisma";
import type { LibraryRole } from "../../types/express";

export type LibrarySummary = { id: number; name: string; address: string; role: LibraryRole };

/** Branches the user can open: all branches of their organization, plus staff assignments. */
export async function listAccessibleLibraries(userId: number): Promise<LibrarySummary[]> {
  const [owned, assigned] = await Promise.all([
    prisma.library.findMany({
      where: { organization: { ownerId: userId } },
      select: { id: true, name: true, address: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.libraryStaff.findMany({
      where: { userId },
      select: { role: true, library: { select: { id: true, name: true, address: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return [
    ...owned.map((l) => ({ ...l, role: "OWNER" as const })),
    ...assigned.map((a) => ({ ...a.library, role: a.role })),
  ];
}

/**
 * New branch with seats labelled 1..seatCount. Only an organization owner can do this,
 * and during a paid period only after paying for the extra branch.
 */
export async function createLibrary(
  userId: number,
  input: { name: string; address: string; seatCount: number; gracePeriodDays?: number },
) {
  const org = await prisma.organization.findUnique({ where: { ownerId: userId }, select: { id: true } });
  if (!org) throw forbidden("Only an owner account can create a branch", "NOT_AN_OWNER");

  return prisma.$transaction(async (tx) => {
    await assertCanAddBranch(tx, org.id);
    const library = await tx.library.create({
      data: {
        organizationId: org.id,
        name: input.name,
        address: input.address,
        gracePeriodDays: input.gracePeriodDays,
      },
    });
    await tx.seat.createMany({
      data: Array.from({ length: input.seatCount }, (_, i) => ({
        libraryId: library.id,
        label: String(i + 1),
        position: i + 1,
      })),
    });
    return library;
  });
}
