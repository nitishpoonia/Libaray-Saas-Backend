import { Response, Request } from "express";
import { prisma } from "../../utils/prisma";
import { convertTimeToMinutes, parseTime } from "../../helpers/basicHelper";
import dayjs from "dayjs";
import { hasTimeOverlap } from "../../utils/timeUtils";

export const getAllAvailableSeats = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const body = (req as any).body;

    if (!user?.id) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const libraryId = Number(req.params.libraryId);
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    if (!body) {
      return res.status(400).json({
        error: "Body is required",
      });
    }

    const { startTime, endTime, bookedFor } = body;

    // Validate required fields
    if (!startTime || !endTime || bookedFor === undefined) {
      return res.status(400).json({
        error: "startTime, endTime, and bookedFor are required",
      });
    }
    console.log("Start time", startTime);

    // Parse time strings using your existing helper
    const parsedStartTime = parseTime(startTime); // Returns Date object
    const parsedEndTime = parseTime(endTime); // Returns Date object

    if (!parsedStartTime || !parsedEndTime) {
      return res.status(400).json({
        error: "Invalid time format. Use HH:MM format",
      });
    }

    // Convert to minutes for easier comparison
    const newStartMinutes =
      parsedStartTime.getHours() * 60 + parsedStartTime.getMinutes();
    const newEndMinutes =
      parsedEndTime.getHours() * 60 + parsedEndTime.getMinutes();

    // Calculate date range
    const startDate = dayjs().toDate();
    const endDate = dayjs().add(bookedFor, "day").toDate();

    // Get all seats for the library
    const allSeats = await prisma.seats.findMany({
      where: {
        library_id: libraryId,
      },
      select: {
        id: true,
        seat_number: true,
        has_locker: true,
      },
    });

    // Get seats that have conflicting memberships
    const bookedSeats = await prisma.memberships.findMany({
      where: {
        library_id: libraryId,
        status: "active",
        // Date range overlap check
        AND: [
          { start_date: { lte: endDate } },
          { end_date: { gte: startDate } },
        ],
      },
      select: {
        seat_id: true,
        start_hour: true,
        start_minute: true,
        end_hour: true,
        end_minute: true,
        crosses_midnight: true,
      },
    });

    // Filter out seats with time conflicts
    const bookedSeatIds = new Set(
      bookedSeats
        .filter((membership) => {
          return hasTimeOverlap(
            newStartMinutes,
            newEndMinutes,
            { hour: membership.start_hour, minute: membership.start_minute },
            { hour: membership.end_hour, minute: membership.end_minute },
            membership.crosses_midnight
          );
        })
        .map((m) => m.seat_id)
    );

    // Return available seats (seats not in the booked set)
    const availableSeats = allSeats.filter(
      (seat) => !bookedSeatIds.has(seat.id)
    );

    return res.status(200).json({
      message: "Available seats retrieved successfully",
      data: {
        availableSeats,
        totalSeats: allSeats.length,
        availableCount: availableSeats.length,
        bookedCount: bookedSeatIds.size,
      },
    });
  } catch (error) {
    console.log("Error getting available seats", error);
    return res.status(500).json({
      error: "Error getting available seats",
    });
  }
};
