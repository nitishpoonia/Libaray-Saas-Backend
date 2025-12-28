// src/modules/library/controller.ts
import { Request, Response } from "express";
import { prisma } from "../../utils/prisma.js";

interface CreateLibraryBody {
  name: string;
  address: string;
  seats?: number;
}

function getAllowedLibrariesCount(owner: {
  subscription_status?: string | null;
  plan_type?: string | null;
  subscription_end?: Date | string | null;
}) {
  const status = (owner.subscription_status || "trial").toLowerCase();

  // If subscription_end exists and is in the past, treat as expired
  if (owner.subscription_end) {
    const end = new Date(owner.subscription_end);
    if (!isNaN(end.getTime()) && end.getTime() < Date.now()) {
      return { allowed: 0, status: "expired" };
    }
  }

  if (status === "trial") return { allowed: 1, status: "trial" };
  if (status === "active") {
    // All paid plans get up to 3 libraries (business rule)
    return { allowed: 3, status: "active" };
  }
  // expired or unknown -> no new libraries
  return { allowed: 0, status: "expired" };
}

export const createLibrary = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const { name, address, seats } = req.body as CreateLibraryBody;
    if (!name || !address || seats === undefined) {
      return res
        .status(400)
        .json({ error: "Name, address and seats are required" });
    }

    // load owner subscription data
    const owner = await prisma.libraryOwner.findUnique({
      where: { id: Number(user.id) },
      select: {
        id: true,
        subscription_status: true,
        subscription_plan: true,
        subscription_end: true,
      },
    });

    if (!owner) return res.status(404).json({ error: "Owner not found" });

    const { allowed, status } = getAllowedLibrariesCount(owner);

    // count existing libraries for owner
    const currentCount = await prisma.library.count({
      where: { library_owner_id: owner.id },
    });

    if (currentCount >= allowed) {
      if (status === "trial") {
        return res.status(403).json({
          error:
            "Trial limit reached. Trial owners can create only 1 library. Upgrade to a paid plan to add more.",
          limit: allowed,
          current: currentCount,
        });
      }
      if (status === "expired") {
        return res.status(403).json({
          error:
            "Subscription expired. You cannot create new libraries. Renew your subscription to continue.",
          limit: allowed,
          current: currentCount,
        });
      }
      return res.status(403).json({
        error: "Library creation limit reached for your plan.",
        limit: allowed,
        current: currentCount,
      });
    }

    // allowed -> proceed with create
    const library = await prisma.library.create({
      data: {
        name,
        address,
        library_owner_id: owner.id,
        trial_start: new Date(),
        trial_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: status === "trial" ? "trial" : "active",
      },
    });

    // Create seats for the library
    if (seats && seats > 0) {
      const seatsData = Array.from({ length: seats }, (_, i) => ({
        library_id: library.id,
        seat_number: String(i + 1),
        has_locker: false,
      }));

      await prisma.seats.createMany({
        data: seatsData,
      });
    }

    return res.status(201).json({ message: "Library created", library });
  } catch (error: any) {
    console.error("Create library error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const getLibraries = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const libraries = await prisma.library.findMany({
      where: { library_owner_id: Number(user.id) },
      orderBy: {
        created_at: "asc",
      },
    });

    return res.status(200).json({
      status: true,
      hasLibrary: libraries.length > 0,
      libraries,
    });
  } catch (error) {
    console.error("Error getting libraries:", error);
    return res.status(500).json({ error: "Error getting libraries in catch" });
  }
};

export const getLibraryOverview = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const libraryId = Number(req.params.id);
    if (Number.isNaN(libraryId)) {
      return res.status(400).json({ error: "Library id must be a number" });
    }

    // Ensure the library exists and belongs to the requesting owner
    const library = await prisma.library.findFirst({
      where: { id: libraryId, library_owner_id: Number(user.id) },
      select: {
        id: true,
        status: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!library) {
      return res.status(404).json({ error: "Library not found" });
    }

    const [
      seatsCount,
      studentsCount,
      membershipsCount,
      activeMembershipsCount,
      paymentsSum,
    ] = await Promise.all([
      prisma.seats.count({ where: { library_id: libraryId } }),
      prisma.students.count({ where: { library_id: libraryId } }),
      prisma.memberships.count({ where: { library_id: libraryId } }),
      prisma.memberships.count({
        where: { library_id: libraryId, status: "active" },
      }),
      prisma.payments.aggregate({
        where: { library_id: libraryId },
        _sum: { amount: true },
      }),
    ]);

    const paymentsTotal = paymentsSum._sum.amount
      ? Number(paymentsSum._sum.amount)
      : 0;

    return res.status(200).json({
      libraryId: library.id,
      status: library.status,
      seats: seatsCount,
      students: studentsCount,
      memberships: {
        total: membershipsCount,
        active: activeMembershipsCount,
      },
      payments: {
        totalAmount: paymentsTotal,
      },
      createdAt: library.created_at,
      updatedAt: library.updated_at,
    });
  } catch (error) {
    console.error("Error getting library overview", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
