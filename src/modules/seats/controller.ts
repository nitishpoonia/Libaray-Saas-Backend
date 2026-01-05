import { Response, Request } from "express";
import { prisma } from "../../utils/prisma";
import { parseTime } from "../../helpers/basicHelper";

export const getAllAvailableSeats = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id)
      return res.status(401).json({
        error: "Unauthorized",
      });

    const libraryId = Number(req.params.libraryId);
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const { start, end } = req.query as {
      start?: string;
      end?: string;
    };

    if (!start || !end) {
      return res.status(400).json({
        error: "Start and End time are required (HH:MM)",
      });
    }

    const startTime = parseTime(start);
    const endTime = parseTime(end);

    if (startTime >= endTime) {
      return res.status(400).json({
        error: "Start time must be before end time",
      });
    }

    const seats = await prisma.seats.findMany({
      where: { library_id: libraryId },
      select: {
        id: true,
        seat_number: true,
      },
    });

    const conflicts = await prisma.memberships.findMany({
      where: {
        library_id: libraryId,
        status: "active",
        AND: [
          { daily_start_time: { lt: endTime } },
          { daily_end_time: { gt: startTime } },
        ],
      },
      select: {
        seat_id: true,
      },
    });
    const occupiedSeatIds = new Set(conflicts.map((c) => c.seat_id));

    const availableSeats = [];
    const occupiedSeats = [];

    for (const seat of seats) {
      if (occupiedSeatIds.has(seat.id)) {
        occupiedSeats.push(seat);
      } else {
        availableSeats.push(seat);
      }
    }

    return res.status(200).json({
      success: true,
      availableSeats,
      occupiedSeats,
    });
  } catch (error) {
    console.log("Error getting available seats", error);
    return res.status(500).json({
      error: "Error getting available seats",
    });
  }
};
