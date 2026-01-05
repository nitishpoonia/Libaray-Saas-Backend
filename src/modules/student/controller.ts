import { Request, Response } from "express";
import { prisma } from "../../utils/prisma";
import { Prisma } from "../../../generated/prisma";
import { formatTime } from "../../helpers/basicHelper";

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

    if (!name) {
      return res.status(400).json({
        error: "Name is required",
      });
    }

    if (!phone) {
      return res.status(400).json({
        error: "Phone is required",
      });
    }
    if (!seat_number) {
      return res.status(400).json({
        error: "Seat Number is required",
      });
    }
    if (!booked_for) {
      return res.status(400).json({
        error: "Booker for duration is required",
      });
    }
    if (!timing) {
      return res.status(400).json({
        error: "Timing is required",
      });
    }
    if (!payment_method) {
      return res.status(400).json({
        error: "Payment Method is required",
      });
    }

    if (!amount) {
      return res.status(400).json({
        error: "Amount is required",
      });
    }
    if (!library_id) {
      return res.status(400).json({
        error: "Library Id is required",
      });
    }

    const [start, end] = timing.split(" - ");

    const today = new Date();

    const daily_start_time = new Date(today);
    const daily_end_time = new Date(today);

    const [startHour, startMin] = start.split(":").map(Number);
    const [endHour, endMin] = end.split(":").map(Number);

    daily_start_time.setHours(startHour, startMin, 0, 0);
    daily_end_time.setHours(endHour, endMin, 0, 0);

    /* ----------------------------------
       2. Calculate membership end date (30 days)
    ---------------------------------- */
    const start_date = new Date();
    const end_date = new Date(start_date);
    end_date.setDate(end_date.getDate() + booked_for);

    const library = await prisma.library.findUnique({
      where: { id: library_id },
    });

    if (!library) {
      return res.status(400).json({ error: "Library not found" });
    }

    const seat = await prisma.seats.findFirst({
      where: {
        library_id,
        seat_number: String(seat_number),
      },
      select: {
        id: true,
      },
    });

    const overlappingMembership = await prisma.memberships.findFirst({
      where: {
        seat_id: seat?.id,
        status: "active",

        AND: [
          {
            daily_start_time: {
              lt: daily_end_time,
            },
          },
          {
            daily_end_time: {
              gt: daily_start_time,
            },
          },
        ],
      },
    });

    if (!seat) {
      return res.status(400).json({ error: "Seat not found" });
    }

    if (overlappingMembership) {
      return res.status(409).json({
        error: "Seat already booked for this time slot",
      });
    }

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

            daily_start_time,
            daily_end_time,

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
    const formattedStudent = {
      ...student,
      memberships: student.memberships.map((m) => ({
        ...m,
        daily_start_time: formatTime(m.daily_start_time),
        daily_end_time: formatTime(m.daily_end_time),
      })),
    };
    return res.status(201).json({
      success: true,
      formattedStudent,
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
            ? `${formatTime(membership.daily_start_time)} - ${formatTime(
                membership.daily_end_time
              )}`
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
