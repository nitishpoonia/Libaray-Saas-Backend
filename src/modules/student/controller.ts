import { Request, Response } from "express";
import { prisma } from "../../utils/prisma";
import { Prisma } from "../../../generated/prisma";
import {
  formatTime,
  hasTimeOverlap,
  isValidTime,
  parseTimingString,
} from "../../utils/timeUtils";
import { parseTime } from "../../helpers/basicHelper";
import dayjs from "dayjs";
import { generateReceiptNumber } from "../../utils/receiptUtils";

interface CreateStudentBody {
  name: string;
  phone: string;
  seat_number: number;
  timing: string;
  booked_for: number;
  payment_method: string;
  total_fee: number;
  amount_paid: number;
  library_id: number;
}

interface AddPaymentBody {
  membership_id: number;
  library_id: number;
  amount: number;
  payment_method: string;
  notes?: string;
}

const deriveMembershipStatus = (
  totalFee: number | Prisma.Decimal,
  paidAmount: number | Prisma.Decimal,
): "paid" | "active" => {
  const total = new Prisma.Decimal(totalFee);
  const paid = new Prisma.Decimal(paidAmount);
  return paid.greaterThanOrEqualTo(total) ? "paid" : "active";
};

export const createStudent = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });
    if (!req.body)
      return res.status(400).json({ error: "Request body is required" });

    const {
      name,
      phone,
      seat_number,
      timing,
      booked_for,
      payment_method,
      total_fee,
      amount_paid,
      library_id,
    } = req.body as CreateStudentBody;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!name) return res.status(400).json({ error: "Name is required" });
    if (!phone) return res.status(400).json({ error: "Phone is required" });
    if (!seat_number)
      return res.status(400).json({ error: "Seat Number is required" });
    if (!booked_for)
      return res.status(400).json({ error: "Booked for duration is required" });
    if (!timing) return res.status(400).json({ error: "Timing is required" });
    if (!payment_method)
      return res.status(400).json({ error: "Payment Method is required" });
    if (!library_id)
      return res.status(400).json({ error: "Library Id is required" });

    if (total_fee === undefined || total_fee === null)
      return res.status(400).json({ error: "Total fee is required" });
    if (amount_paid === undefined || amount_paid === null)
      return res.status(400).json({ error: "Amount paid is required" });
    if (amount_paid < 0)
      return res.status(400).json({ error: "Amount paid cannot be negative" });
    if (amount_paid > total_fee)
      return res
        .status(400)
        .json({ error: "Amount paid cannot exceed total fee" });

    // ── Parse & validate timing ───────────────────────────────────────────────
    const timeSlot = parseTimingString(timing);
    const [startTime, endTime] = timing.split(" - ");
    const parsedStartTime = parseTime(startTime);
    const parsedEndTime = parseTime(endTime);

    if (!parsedStartTime || !parsedEndTime) {
      return res
        .status(400)
        .json({ error: "Invalid time format. Use HH:MM format" });
    }

    if (
      !isValidTime(timeSlot.start_hour, timeSlot.start_minute) ||
      !isValidTime(timeSlot.end_hour, timeSlot.end_minute)
    ) {
      return res.status(400).json({
        error: "Invalid time format. Hours must be 0-23, minutes 0-59",
      });
    }

    const newStartMinutes =
      parsedStartTime.getHours() * 60 + parsedStartTime.getMinutes();
    const newEndMinutes =
      parsedEndTime.getHours() * 60 + parsedEndTime.getMinutes();

    // ── Seat availability check ───────────────────────────────────────────────
    const startDate = dayjs().toDate();
    const endDate = dayjs().add(booked_for, "day").toDate();

    const allSeats = await prisma.seats.findMany({
      where: { library_id },
      select: { id: true, seat_number: true, has_locker: true },
    });

    const bookedSeats = await prisma.memberships.findMany({
      where: {
        library_id,
        status: { in: ["active", "paid"] }, // ← check both statuses
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

    const bookedSeatIds = new Set(
      bookedSeats
        .filter((membership) =>
          hasTimeOverlap(
            newStartMinutes,
            newEndMinutes,
            { hour: membership.start_hour, minute: membership.start_minute },
            { hour: membership.end_hour, minute: membership.end_minute },
            membership.crosses_midnight,
          ),
        )
        .map((m) => m.seat_id),
    );

    const availableSeats = allSeats.filter(
      (seat) => !bookedSeatIds.has(seat.id),
    );

    const isSeatAvailable = availableSeats.some(
      (seat) => Number(seat.seat_number) === Number(seat_number),
    );

    if (!isSeatAvailable) {
      return res
        .status(403)
        .json({ error: "This seat number is not available" });
    }

    // ── Library & seat lookup ─────────────────────────────────────────────────
    const library = await prisma.library.findUnique({
      where: { id: library_id },
    });
    if (!library) return res.status(400).json({ error: "Library not found" });

    const seat = await prisma.seats.findFirst({
      where: { library_id, seat_number: String(seat_number) },
      select: { id: true },
    });
    if (!seat) return res.status(400).json({ error: "Seat not found" });

    // ── Generate receipt number before the transaction ────────────────────────
    const receiptNumber = await generateReceiptNumber();

    // ── Derive initial membership status ─────────────────────────────────────
    const membershipStatus = deriveMembershipStatus(total_fee, amount_paid);

    // ── Create student + membership + first payment atomically ────────────────
    const student = await prisma.students.create({
      data: {
        name,
        phone,
        library: { connect: { id: library_id } },
        memberships: {
          create: {
            start_date: startDate,
            end_date: endDate,
            status: membershipStatus, // "paid" or "active"
            total_fee: new Prisma.Decimal(total_fee),
            paid_amount: new Prisma.Decimal(amount_paid), // ← new field
            start_hour: timeSlot.start_hour,
            start_minute: timeSlot.start_minute,
            end_hour: timeSlot.end_hour,
            end_minute: timeSlot.end_minute,
            crosses_midnight: timeSlot.crosses_midnight,
            library: { connect: { id: library_id } },
            seat: { connect: { id: seat.id } },
            payments: {
              create: {
                amount: new Prisma.Decimal(amount_paid),
                payment_mode: payment_method,
                payment_date: new Date(),
                receipt_number: receiptNumber, // ← new field
                library: { connect: { id: library_id } },
              },
            },
          },
        },
      },
      include: {
        memberships: {
          include: { payments: true, seat: true },
        },
      },
    });

    // ── Format response ───────────────────────────────────────────────────────
    const membership = student.memberships[0];
    const payment = membership.payments[0];

    const formattedStudent = {
      ...student,
      memberships: student.memberships.map((m) => ({
        ...m,
        pending_amount: new Prisma.Decimal(m.total_fee)
          .minus(new Prisma.Decimal(m.paid_amount))
          .toNumber(),
        timing: `${formatTime(m.start_hour, m.start_minute)} - ${formatTime(m.end_hour, m.end_minute)}`,
      })),
    };

    return res.status(201).json({
      success: true,
      student: formattedStudent,
      receipt: {
        receipt_number: payment.receipt_number,
        student_name: student.name,
        seat_number: seat_number,
        total_fee,
        amount_paid,
        pending_amount: total_fee - amount_paid,
        payment_mode: payment_method,
        payment_date: payment.payment_date,
        membership_start: startDate,
        membership_end: endDate,
        timing,
      },
    });
  } catch (error) {
    console.error("Error creating student", error);
    return res.status(500).json({ error: "Error creating student" });
  }
};

export const addPayment = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const { membership_id, library_id, amount, payment_method, notes } =
      req.body as AddPaymentBody;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!membership_id)
      return res.status(400).json({ error: "Membership ID is required" });
    if (!library_id)
      return res.status(400).json({ error: "Library ID is required" });
    if (!amount || amount <= 0)
      return res
        .status(400)
        .json({ error: "A valid payment amount is required" });
    if (!payment_method)
      return res.status(400).json({ error: "Payment method is required" });

    // ── Fetch membership ──────────────────────────────────────────────────────
    const membership = await prisma.memberships.findFirst({
      where: { id: membership_id, library_id },
      include: { student: true, seat: true },
    });

    if (!membership) {
      return res.status(404).json({ error: "Membership not found" });
    }

    if (membership.status === "expired") {
      return res
        .status(400)
        .json({ error: "Cannot add payment to an expired membership" });
    }

    // ── Check payment doesn't exceed pending amount ───────────────────────────
    const currentPaid = new Prisma.Decimal(membership.paid_amount);
    const totalFee = new Prisma.Decimal(membership.total_fee);
    const pendingAmount = totalFee.minus(currentPaid);

    if (pendingAmount.lessThanOrEqualTo(0)) {
      return res
        .status(400)
        .json({ error: "No pending amount for this membership" });
    }

    const paymentAmount = new Prisma.Decimal(amount);
    if (paymentAmount.greaterThan(pendingAmount)) {
      return res.status(400).json({
        error: `Amount exceeds pending dues. Maximum payable: ${pendingAmount.toNumber()}`,
      });
    }

    // ── Generate receipt number ───────────────────────────────────────────────
    const receiptNumber = await generateReceiptNumber();

    // ── Update membership + create payment atomically ─────────────────────────
    const newPaidAmount = currentPaid.plus(paymentAmount);
    const newStatus = deriveMembershipStatus(totalFee, newPaidAmount);

    const [payment] = await prisma.$transaction([
      prisma.payments.create({
        data: {
          amount: paymentAmount,
          payment_mode: payment_method,
          payment_date: new Date(),
          receipt_number: receiptNumber,
          notes: notes ?? null,
          library: { connect: { id: library_id } },
          membership: { connect: { id: membership_id } },
        },
      }),
      prisma.memberships.update({
        where: { id: membership_id },
        data: {
          paid_amount: newPaidAmount,
          status: newStatus,
        },
      }),
    ]);

    const remainingPending = pendingAmount.minus(paymentAmount);

    return res.status(200).json({
      success: true,
      receipt: {
        receipt_number: receiptNumber,
        student_name: membership.student.name,
        seat_number: membership.seat.seat_number,
        total_fee: totalFee.toNumber(),
        amount_paid_now: paymentAmount.toNumber(),
        total_paid_so_far: newPaidAmount.toNumber(),
        pending_amount: remainingPending.toNumber(),
        payment_mode: payment_method,
        payment_date: payment.payment_date,
        membership_status: newStatus,
      },
    });
  } catch (error) {
    console.error("Error adding payment", error);
    return res.status(500).json({ error: "Error adding payment" });
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

    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const status = (req.query.status as string) || "active";

    // pagination
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const skip = (page - 1) * limit;
    const { search } = req.query;

    console.log(req.query);
    const where: any = {
      library_id: libraryId,
      ...(search && {
        name: {
          contains: search as string,
          mode: "insensitive",
        },
      }),
      isActive: true,
    };

    const [students, total] = await Promise.all([
      prisma.students.findMany({
        where,
        skip,
        take: limit,
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
      }),

      prisma.students.count({
        where,
      }),
    ]);

    const result = students
      .filter((student) => {
        const hasActiveMembership = student.memberships.length > 0;

        if (status === "active") return hasActiveMembership;
        if (status === "inactive") return !hasActiveMembership;
        return true;
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
                membership.start_minute,
              )} - ${formatTime(membership.end_hour, membership.end_minute)}`
            : null,

          membershipStatus: membership?.status ?? "inactive",
          membershipEndDate: membership?.end_date ?? null,
          membershipId: membership?.id,

          daysRemaining: membership
            ? Math.max(
                0,
                Math.ceil(
                  (new Date(membership.end_date).getTime() - Date.now()) /
                    (1000 * 60 * 60 * 24),
                ),
              )
            : null,
        };
      });

    return res.status(200).json({
      success: true,
      students: result,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("List students error:", error);
    return res.status(500).json({
      error: "Failed to fetch students",
    });
  }
};

export const markStudentFeesAsPaid = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const {
      studentId,
      libraryId,
      amount,
      datePaidOn,
      membershipId,
      paymentMode = "CASH",
    } = req.body;

    if (!user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!libraryId) {
      return res.status(400).json({ error: "Library ID is required" });
    }
    if (!studentId) {
      return res.status(400).json({ error: "Student ID is required" });
    }
    if (!membershipId) {
      return res.status(400).json({ error: "Membership ID is required" });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Valid amount is required" });
    }
    if (!datePaidOn || !dayjs(datePaidOn).isValid()) {
      return res.status(400).json({ error: "Valid payment date is required" });
    }

    const membership = await prisma.memberships.findFirst({
      where: {
        id: membershipId,
        student_id: studentId,
        library_id: libraryId,
      },
    });

    if (!membership) {
      return res.status(404).json({
        error: "Membership not found for this student and library",
      });
    }

    const MEMBERSHIP_DURATION_DAYS = 30;
    const newEndDate = dayjs(datePaidOn)
      .add(MEMBERSHIP_DURATION_DAYS, "day")
      .toDate();

    // Use transaction
    const result = await prisma.$transaction(async (tx) => {
      const updatedMembership = await tx.memberships.update({
        where: {
          id: membershipId,
        },
        data: {
          end_date: newEndDate,
          status: "ACTIVE",
        },
      });

      // Create payment record
      const payment = await tx.payments.create({
        data: {
          library_id: libraryId,
          membership_id: membershipId,
          amount: amount,
          payment_date: new Date(datePaidOn),
          payment_mode: paymentMode,
        },
      });

      return { membership: updatedMembership, payment };
    });

    return res.status(200).json({
      message: "Payment recorded and membership extended successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error marking student fees as paid:", error);
    return res.status(500).json({
      error: "An error occurred while processing the payment",
    });
  }
};

export const listOverdueStudents = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id;

    const libraryId = await prisma.library.findUnique({
      where: {
        library_owner_id: userId,
      },
      select: {
        id: true,
      },
    });
    console.log("lbary id", libraryId);
    if (!libraryId)
      return res.status(400).json({ error: "No library exists for this user" });
    const today = dayjs().startOf("day").toDate();

    const overdueStudentList = await prisma.memberships.findMany({
      where: {
        library_id: libraryId?.id,
        end_date: {
          lt: today,
        },
      },
      select: {
        end_date: true,
        student: true,
      },
    });

    return res.status(200).json({
      message: "Student list",
      overdueStudentList,
    });
  } catch (error) {
    console.error("Error listing overdue students", error);
    return res.status(500).json({
      error: "Error listing overdue students",
    });
  }
};

export const listExpiringSoonStudents = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const userId = user?.id;

    const libraryId = await prisma.library.findUnique({
      where: {
        library_owner_id: userId,
      },
      select: {
        id: true,
      },
    });

    const sevenDaysLater = dayjs().add(7, "day").endOf("day").toDate();
    const today = dayjs().startOf("day").toDate();

    const expiringSoonList = await prisma.memberships.findMany({
      where: {
        library_id: libraryId?.id,
        end_date: {
          gte: today,
          lte: sevenDaysLater,
        },
      },
      select: {
        end_date: true,
        student: true,
      },
    });

    return res.status(200).json({
      message: "Expiring Student list",
      expiringSoonList,
    });
  } catch (error) {
    console.error("Error listing expiring students", error);
    return res.status(500).json({
      error: "Error listing expiring soon students",
    });
  }
};
