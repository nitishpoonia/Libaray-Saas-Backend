import { Request, Response } from "express";
import { prisma } from "../../utils/prisma";
import { Prisma } from "../../../generated/prisma";
import {
  doTimeSlotsOverlap,
  formatTime,
  isValidTime,
  parseTimingString,
} from "../../utils/timeUtils";

interface CreateStudentBody {
  name: string;
  phone: string;
  seat_number: number;
  timing: string;
  booked_for: number;
  payment_method: string;
  amount: number;
  library_id: number;
}

export const createStudent = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });
    if (!req.body) {
      return res.status(400).json({ error: "Request body is required" });
    }

    const {
      name,
      phone,
      seat_number,
      timing,
      booked_for,
      payment_method,
      amount,
      library_id,
    } = req.body as CreateStudentBody;

    // Validate required fields
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!phone) return res.status(400).json({ error: "Phone is required" });
    if (!seat_number)
      return res.status(400).json({ error: "Seat Number is required" });
    if (!booked_for)
      return res.status(400).json({ error: "Booked for duration is required" });
    if (!timing) return res.status(400).json({ error: "Timing is required" });
    if (!payment_method)
      return res.status(400).json({ error: "Payment Method is required" });
    if (!amount) return res.status(400).json({ error: "Amount is required" });
    if (!library_id)
      return res.status(400).json({ error: "Library Id is required" });

    // Parse timing
    const timeSlot = parseTimingString(timing);

    // Validate time format
    if (
      !isValidTime(timeSlot.start_hour, timeSlot.start_minute) ||
      !isValidTime(timeSlot.end_hour, timeSlot.end_minute)
    ) {
      return res.status(400).json({
        error: "Invalid time format. Hours must be 0-23, minutes 0-59",
      });
    }

    // Calculate membership dates
    const start_date = new Date();
    const end_date = new Date(start_date);
    end_date.setDate(end_date.getDate() + booked_for);

    // Verify library exists
    const library = await prisma.library.findUnique({
      where: { id: library_id },
    });
    if (!library) {
      return res.status(400).json({ error: "Library not found" });
    }

    // Find seat
    const seat = await prisma.seats.findFirst({
      where: {
        library_id,
        seat_number: String(seat_number),
      },
      select: { id: true },
    });
    if (!seat) {
      return res.status(400).json({ error: "Seat not found" });
    }

    // Get all active memberships for this seat
    const existingMemberships = await prisma.memberships.findMany({
      where: {
        seat_id: seat.id,
        status: "active",
      },
      select: {
        start_hour: true,
        start_minute: true,
        end_hour: true,
        end_minute: true,
        crosses_midnight: true,
      },
    });

    // Create student with membership
    const student = await prisma.students.create({
      data: {
        name,
        phone,
        library: {
          connect: { id: library_id },
        },
        memberships: {
          create: {
            start_date,
            end_date,
            status: "active",
            start_hour: timeSlot.start_hour,
            start_minute: timeSlot.start_minute,
            end_hour: timeSlot.end_hour,
            end_minute: timeSlot.end_minute,
            crosses_midnight: timeSlot.crosses_midnight,
            total_fee: new Prisma.Decimal(amount),
            library: {
              connect: { id: library_id },
            },
            seat: {
              connect: { id: seat.id },
            },
            payments: {
              create: {
                amount: new Prisma.Decimal(amount),
                payment_mode: payment_method,
                payment_date: new Date(),
                library: {
                  connect: { id: library_id },
                },
              },
            },
          },
        },
      },
      include: {
        memberships: {
          include: {
            payments: true,
            seat: true,
          },
        },
      },
    });

    // Format response
    const formattedStudent = {
      ...student,
      memberships: student.memberships.map((m) => ({
        ...m,
        timing: `${formatTime(m.start_hour, m.start_minute)} - ${formatTime(
          m.end_hour,
          m.end_minute
        )}`,
      })),
    };

    return res.status(201).json({
      success: true,
      student: formattedStudent,
    });
  } catch (error) {
    console.log("Error creating student", error);
    return res.status(500).json({
      error: "Error creating student",
    });
  }
};

export const deleteStudent = async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.id) return res.status(401).json({ error: "Unauthorized" });
  if (!req.body) {
    return res.status(400).json({ error: "Request body is required" });
  }

  try {
    const { student_id } = req.body as {
      student_id: number;
    };
    if (!student_id) {
      return res.status(400).json({ error: "Student ID is required" });
    }

    const student = await prisma.students.findUnique({
      where: { id: student_id },
      include: {
        memberships: {
          where: { status: "active" },
        },
      },
    });

    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }
    if (!student.isActive) {
      return res.status(400).json({
        error: "Student is already inactive",
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.memberships.updateMany({
        where: {
          student_id: student_id,
          status: "active",
        },
        data: {
          status: "expired",
          end_date: new Date(),
        },
      });
      await tx.students.update({
        where: { id: student_id },
        data: {
          isActive: false,
        },
      });
    });

    return res.status(200).json({
      success: true,
      message: "Student removed and seat released",
    });
  } catch (error) {
    console.log("Error deleting student", error);

    return res.status(500).json({
      error: "Error deleting student",
    });
  }
};

export const getAllStudents = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const libraryId = Number(req.params.libraryId);
    console.log("libarary id", libraryId);

    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const status = (req.query.status as string) || "active";
    // allowed: active | inactive | all

    const students = await prisma.students.findMany({
      where: {
        library_id: libraryId,
        isActive: true,
      },
      include: {
        memberships: {
          where: {
            status: "active",
          },
          include: {
            seat: true,
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const result = students
      .filter((student) => {
        const hasActiveMembership = student.memberships.length > 0;

        if (status === "active") return hasActiveMembership;
        if (status === "inactive") return !hasActiveMembership;
        return true; // all
      })
      .map((student) => {
        const membership = student.memberships[0] || null;

        return {
          studentId: student.id,
          name: student.name,
          phone: student.phone,

          seatNumber: membership?.seat?.seat_number ?? null,
          timing: membership
            ? `${formatTime(
                membership.start_hour,
                membership.start_minute
              )} - ${formatTime(membership.end_hour, membership.end_minute)}`
            : null,

          membershipStatus: membership?.status ?? "inactive",
          membershipEndDate: membership?.end_date ?? null,

          daysRemaining: membership
            ? Math.max(
                0,
                Math.ceil(
                  (new Date(membership.end_date).getTime() - Date.now()) /
                    (1000 * 60 * 60 * 24)
                )
              )
            : null,
        };
      });

    return res.status(200).json({
      success: true,
      count: result.length,
      students: result,
    });
  } catch (error) {
    console.error("List students error:", error);
    return res.status(500).json({
      error: "Failed to fetch students",
    });
  }
};
