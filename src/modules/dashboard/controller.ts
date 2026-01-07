import { Request, Response } from "express";
import { prisma } from "../../utils/prisma.js";

export const getDashboard = async (req: Request, res: Response) => {
  console.log("**********************************");

  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const libraryId = Number(req.params.libraryId);
    if (Number.isNaN(libraryId)) {
      return res.status(400).json({ error: "Library id must be a number" });
    }

    const activeStudentsCount = await prisma.memberships.count({
      where: {
        library_id: libraryId,
        status: "active",
      },
    });

    const totalSeats = await prisma.seats.count({
      where: {
        library_id: libraryId,
      },
    });

    const occupiedSeats = activeStudentsCount;

    const expensesSum = await prisma.expenses.aggregate({
      where: {
        library_id: libraryId,
      },
      _sum: {
        amount: true,
      },
    });
    const totalExpenses = expensesSum._sum.amount ?? 0;
    console.log("Total Expense", expensesSum);

    const revenueSum = await prisma.payments.aggregate({
      where: {
        library_id: libraryId,
      },
      _sum: {
        amount: true,
      },
    });

    const totalRevenue = revenueSum._sum.amount ?? 0;
    const library = await prisma.library.findUnique({
      where: { id: libraryId },
      select: {
        status: true,
        subscription_end: true,
        name: true,
      },
    });

    if (!library) {
      return res.status(404).json({ error: "Library not found" });
    }

    const libaryName = library.name;

    const daysRemaining = library?.subscription_end
      ? Math.max(
          0,
          Math.ceil(
            (library.subscription_end.getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          )
        )
      : 0;

    const totalStudentsCount = await prisma.students.count({
      where: {
        library_id: libraryId,
      },
    });

    return res.status(200).json({
      success: true,
      libraryName: libaryName,
      dashboard: {
        seats: {
          total: totalSeats,
          occupied: occupiedSeats,
          available: totalSeats - occupiedSeats,
        },
        students: {
          active: activeStudentsCount,
          inactive: totalStudentsCount - activeStudentsCount,
        },
        finance: {
          revenue: Number(totalRevenue),
          expenses: Number(totalExpenses),
          balance: Number(totalRevenue) - Number(totalExpenses),
        },
        subscription: {
          status: library.status,
          endsOn: library.subscription_end,
          daysRemaining,
        },
      },
    });
  } catch (error) {
    console.error("Error getting library overview:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
