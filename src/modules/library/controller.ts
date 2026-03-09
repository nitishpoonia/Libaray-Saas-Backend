// src/modules/library/controller.ts
import { Request, Response } from "express";
import { prisma } from "../../utils/prisma.js";
import { error, log } from "console";

interface CreateLibraryBody {
  name: string;
  address: string;
  seats?: number;
}

export const createLibrary = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const { name, address, seats } = req.body as CreateLibraryBody;
    console.log("Create library request body:", req.body, user);
    if (!name || !address || seats === undefined) { 
      return res
        .status(400)
        .json({ error: "Name, address and seats are required" });
    }

    const library = await prisma.library.create({
      data: {
        name,
        address,
        library_owner_id: user?.id,
        subscription_start: new Date(),
        subscription_end: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        status: "trial",
      },
    });

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
    console.log("Seats", seatsCount);
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

export const updateLibrary = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const { libraryName, seats, address } = req.body;

    if (!libraryName && !seats && !address)
      return res.status(400).json({
        error: "At least one field is required",
      });

    const library = await prisma.library.findUnique({
      where: { library_owner_id: user.id },
      include: { seats: { include: { memberships: true } } },
    });

    if (!library) return res.status(404).json({ error: "Library not found" });

    // 🪑 Seat Count Handling
    if (typeof seats === "number") {
      if (seats <= 0)
        return res.status(400).json({
          error: "Seats must be greater than 0",
        });

      const currentSeatCount = library.seats.length;

      // Increasing seat count
      if (seats > currentSeatCount) {
        const seatsToCreate = Array.from(
          { length: seats - currentSeatCount },
          (_, i) => ({
            library_id: library.id,
            seat_number: String(currentSeatCount + i + 1),
            has_locker: false,
          }),
        );

        await prisma.seats.createMany({
          data: seatsToCreate,
        });
      }

      // Decreasing seat count
      if (seats < currentSeatCount) {
        const seatsSorted = library.seats.sort(
          (a, b) => Number(a.seat_number) - Number(b.seat_number),
        );

        const seatsToRemove = seatsSorted.slice(seats);

        const occupiedSeats = seatsToRemove.filter(
          (seat) => seat.memberships.length > 0,
        );

        if (occupiedSeats.length > 0) {
          return res.status(400).json({
            error:
              "Cannot reduce seat count because some seats are assigned to active memberships",
          });
        }

        await prisma.seats.deleteMany({
          where: {
            id: { in: seatsToRemove.map((s) => s.id) },
          },
        });
      }
    }

    // ✏️ Update basic fields
    await prisma.library.update({
      where: { library_owner_id: user.id },
      data: {
        name: libraryName ?? undefined,
        address: address ?? undefined,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Library updated successfully",
    });
  } catch (error) {
    console.error("Error updating library details", error);
    return res.status(500).json({
      error: "Error updating library details",
    });
  }
};
