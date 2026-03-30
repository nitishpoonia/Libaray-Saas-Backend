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

interface UpdateStudentBody {
  name?: string;
  phone?: string;
}

interface RenewMembershipBody {
  membership_id: number;
  student_id: number;
  amount: number;
  payment_method: string;
  renewal_days: number;
  renewal_fee?: number;
  notes?: string;
  seat_number?: number | string;
  timing?: string;
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
      total_fee: totalFee,
      amount_paid: amountPaid,
      library_id,
    } = req.body as CreateStudentBody;
    console.log("Create student request body:", req.body);

    const total_fee = Number(totalFee);
    const amount_paid = Number(amountPaid);

    console.log(typeof total_fee);

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
            paid_amount: new Prisma.Decimal(amount_paid),
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

export const renewMembership = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: "Unauthorized" });

    const libraryId = Number(req.params.libraryId);
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const {
      membership_id,
      student_id,
      amount,
      payment_method,
      renewal_days,
      renewal_fee,
      notes,
      seat_number,
      timing,
    } = req.body as RenewMembershipBody;

    if (!membership_id)
      return res.status(400).json({ error: "Membership ID is required" });
    if (!student_id)
      return res.status(400).json({ error: "Student ID is required" });
    if (!payment_method)
      return res.status(400).json({ error: "Payment method is required" });

    const renewalDays = Number(renewal_days);
    const paymentAmountNumber = Number(amount);
    const renewalFeeNumber =
      renewal_fee === undefined ? paymentAmountNumber : Number(renewal_fee);

    if (!Number.isFinite(paymentAmountNumber) || paymentAmountNumber <= 0) {
      return res
        .status(400)
        .json({ error: "A valid payment amount is required" });
    }
    if (!Number.isFinite(renewalDays) || renewalDays <= 0) {
      return res
        .status(400)
        .json({ error: "Renewal days must be greater than 0" });
    }
    if (!Number.isFinite(renewalFeeNumber) || renewalFeeNumber <= 0) {
      return res.status(400).json({ error: "A valid renewal fee is required" });
    }
    if (paymentAmountNumber > renewalFeeNumber) {
      return res.status(400).json({
        error: "Amount paid cannot exceed renewal fee",
      });
    }

    const membership = await prisma.memberships.findFirst({
      where: {
        id: membership_id,
        student_id,
        library_id: libraryId,
      },
      include: {
        student: true,
        seat: {
          select: {
            id: true,
            seat_number: true,
            has_locker: true,
          },
        },
      },
    });

    if (!membership) {
      return res.status(404).json({
        error: "Membership not found for this student and library",
      });
    }

    let nextSeatId = membership.seat_id;
    let nextSeatNumber = membership.seat.seat_number;
    let nextStartHour = membership.start_hour;
    let nextStartMinute = membership.start_minute;
    let nextEndHour = membership.end_hour;
    let nextEndMinute = membership.end_minute;
    let nextCrossesMidnight = membership.crosses_midnight;

    if (timing !== undefined) {
      const parsed = parseTimingString(timing);
      const [startTime, endTime] = timing.split(" - ");
      const parsedStartTime = parseTime(startTime);
      const parsedEndTime = parseTime(endTime);

      if (!parsedStartTime || !parsedEndTime) {
        return res
          .status(400)
          .json({ error: "Invalid time format. Use HH:MM format" });
      }

      if (
        !isValidTime(parsed.start_hour, parsed.start_minute) ||
        !isValidTime(parsed.end_hour, parsed.end_minute)
      ) {
        return res.status(400).json({
          error: "Invalid time format. Hours must be 0-23, minutes 0-59",
        });
      }

      nextStartHour = parsed.start_hour;
      nextStartMinute = parsed.start_minute;
      nextEndHour = parsed.end_hour;
      nextEndMinute = parsed.end_minute;
      nextCrossesMidnight = parsed.crosses_midnight;
    }

    if (seat_number !== undefined) {
      const targetSeat = await prisma.seats.findFirst({
        where: {
          library_id: libraryId,
          seat_number: String(seat_number),
        },
        select: {
          id: true,
          seat_number: true,
        },
      });

      if (!targetSeat) {
        return res.status(400).json({ error: "Seat not found" });
      }

      nextSeatId = targetSeat.id;
      nextSeatNumber = targetSeat.seat_number;
    }

    const now = new Date();
    const oldEndDate = membership.end_date;
    const extendFromDate = dayjs(membership.end_date).isAfter(now)
      ? membership.end_date
      : now;
    const newEndDate = dayjs(extendFromDate).add(renewalDays, "day").toDate();

    // Check conflicts only for the newly booked period and ignore this membership itself.
    const overlapStartDate = dayjs(membership.end_date).isAfter(now)
      ? membership.end_date
      : now;

    const potentiallyConflicting = await prisma.memberships.findMany({
      where: {
        id: { not: membership.id },
        library_id: libraryId,
        seat_id: nextSeatId,
        status: { in: ["active", "paid"] },
        AND: [
          { start_date: { lte: newEndDate } },
          { end_date: { gte: overlapStartDate } },
        ],
      },
      select: {
        start_hour: true,
        start_minute: true,
        end_hour: true,
        end_minute: true,
        crosses_midnight: true,
      },
    });

    const requestedStartMinutes = nextStartHour * 60 + nextStartMinute;
    const requestedEndMinutes = nextEndHour * 60 + nextEndMinute;

    const hasConflict = potentiallyConflicting.some((existing) =>
      hasTimeOverlap(
        requestedStartMinutes,
        requestedEndMinutes,
        { hour: existing.start_hour, minute: existing.start_minute },
        { hour: existing.end_hour, minute: existing.end_minute },
        existing.crosses_midnight,
      ),
    );

    if (hasConflict) {
      return res
        .status(403)
        .json({ error: "This seat number is not available" });
    }

    const paymentAmount = new Prisma.Decimal(paymentAmountNumber);
    const renewalFee = new Prisma.Decimal(renewalFeeNumber);
    const currentPaidAmount = new Prisma.Decimal(membership.paid_amount);
    const currentTotalFee = new Prisma.Decimal(membership.total_fee);

    const updatedPaidAmount = currentPaidAmount.plus(paymentAmount);
    const updatedTotalFee = currentTotalFee.plus(renewalFee);
    const updatedStatus = deriveMembershipStatus(
      updatedTotalFee,
      updatedPaidAmount,
    );
    const pendingAmount = updatedTotalFee.minus(updatedPaidAmount);

    const receiptNumber = await generateReceiptNumber();

    const [payment] = await prisma.$transaction([
      prisma.payments.create({
        data: {
          amount: paymentAmount,
          payment_mode: payment_method,
          payment_date: new Date(),
          receipt_number: receiptNumber,
          notes: notes ?? null,
          library: { connect: { id: libraryId } },
          membership: { connect: { id: membership.id } },
        },
      }),
      prisma.memberships.update({
        where: { id: membership.id },
        data: {
          end_date: newEndDate,
          total_fee: updatedTotalFee,
          paid_amount: updatedPaidAmount,
          status: updatedStatus,
          seat: { connect: { id: nextSeatId } },
          start_hour: nextStartHour,
          start_minute: nextStartMinute,
          end_hour: nextEndHour,
          end_minute: nextEndMinute,
          crosses_midnight: nextCrossesMidnight,
        },
      }),
      prisma.students.update({
        where: { id: student_id },
        data: { isActive: true },
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Membership renewed successfully",
      receipt: {
        receipt_number: receiptNumber,
        student_name: membership.student.name,
        seat_number: nextSeatNumber,
        renewal_days: renewalDays,
        old_end_date: oldEndDate,
        new_end_date: newEndDate,
        renewal_fee: renewalFee.toNumber(),
        amount_paid_now: paymentAmount.toNumber(),
        total_paid_so_far: updatedPaidAmount.toNumber(),
        pending_amount: pendingAmount.toNumber(),
        payment_mode: payment_method,
        payment_date: payment.payment_date,
        membership_status: updatedStatus,
        timing: `${formatTime(nextStartHour, nextStartMinute)} - ${formatTime(nextEndHour, nextEndMinute)}`,
      },
    });
  } catch (error) {
    console.error("Error renewing membership", error);
    return res.status(500).json({ error: "Failed to renew membership" });
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

export const updateStudentDetails = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const studentId = Number(req.params.studentId);
    const libraryId = Number(req.params.libraryId);

    if (isNaN(studentId)) {
      return res.status(400).json({ error: "Invalid student id" });
    }
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const { name, phone } = (req.body || {}) as UpdateStudentBody;

    if (name === undefined && phone === undefined) {
      return res.status(400).json({
        error: "At least one field is required: name or phone",
      });
    }

    const updateData: Prisma.StudentsUpdateInput = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ error: "Name cannot be empty" });
      }
      updateData.name = trimmedName;
    }

    if (phone !== undefined) {
      const trimmedPhone = phone.trim();
      if (!trimmedPhone) {
        return res.status(400).json({ error: "Phone cannot be empty" });
      }
      updateData.phone = trimmedPhone;
    }

    const studentExists = await prisma.students.findFirst({
      where: {
        id: studentId,
        library_id: libraryId,
      },
      select: { id: true },
    });

    if (!studentExists) {
      return res.status(404).json({ error: "Student not found" });
    }

    const updatedStudent = await prisma.students.update({
      where: { id: studentId },
      data: updateData,
      include: {
        memberships: {
          where: {
            status: { in: ["active", "paid"] },
          },
          include: {
            seat: true,
          },
          orderBy: {
            created_at: "desc",
          },
          take: 1,
        },
      },
    });

    const currentMembership = updatedStudent.memberships[0] || null;

    return res.status(200).json({
      success: true,
      message: "Student details updated successfully",
      student: {
        studentId: updatedStudent.id,
        name: updatedStudent.name,
        phone: updatedStudent.phone,
        isActive: updatedStudent.isActive,
        createdAt: updatedStudent.created_at,
        updatedAt: updatedStudent.updated_at,
        currentMembership: currentMembership
          ? {
              membershipId: currentMembership.id,
              seatNumber: currentMembership.seat.seat_number,
              status: currentMembership.status,
              endDate: currentMembership.end_date,
              timing: `${formatTime(currentMembership.start_hour, currentMembership.start_minute)} - ${formatTime(currentMembership.end_hour, currentMembership.end_minute)}`,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Error updating student details:", error);
    return res.status(500).json({
      error: "Failed to update student details",
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

export const getStudentDetails = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const studentId = Number(req.params.studentId);
    const libraryId = Number(req.params.libraryId);

    if (isNaN(studentId)) {
      return res.status(400).json({ error: "Invalid student id" });
    }
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const student = await prisma.students.findFirst({
      where: {
        id: studentId,
        library_id: libraryId,
      },
      include: {
        memberships: {
          include: {
            seat: {
              select: {
                id: true,
                seat_number: true,
                has_locker: true,
              },
            },
            payments: {
              orderBy: {
                payment_date: "desc",
              },
            },
          },
          orderBy: {
            created_at: "desc",
          },
        },
      },
    });

    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const formattedMemberships = student.memberships.map((membership) => {
      const totalFee = new Prisma.Decimal(membership.total_fee);
      const paidAmount = new Prisma.Decimal(membership.paid_amount);
      const pendingAmount = totalFee.minus(paidAmount);

      return {
        membershipId: membership.id,
        startDate: membership.start_date,
        endDate: membership.end_date,
        status: membership.status,
        totalFee: totalFee.toNumber(),
        paidAmount: paidAmount.toNumber(),
        pendingAmount: pendingAmount.toNumber(),
        timing: `${formatTime(
          membership.start_hour,
          membership.start_minute,
        )} - ${formatTime(membership.end_hour, membership.end_minute)}`,
        seat: {
          seatId: membership.seat.id,
          seatNumber: membership.seat.seat_number,
          hasLocker: membership.seat.has_locker,
        },
        daysRemaining: Math.max(
          0,
          Math.ceil(
            (new Date(membership.end_date).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24),
          ),
        ),
        payments: membership.payments.map((payment) => ({
          paymentId: payment.id,
          amount: new Prisma.Decimal(payment.amount).toNumber(),
          paymentDate: payment.payment_date,
          paymentMode: payment.payment_mode,
          receiptNumber: payment.receipt_number,
          notes: payment.notes,
        })),
      };
    });

    return res.status(200).json({
      success: true,
      student: {
        studentId: student.id,
        name: student.name,
        phone: student.phone,
        isActive: student.isActive,
        createdAt: student.created_at,
        updatedAt: student.updated_at,
        memberships: formattedMemberships,
      },
    });
  } catch (error) {
    console.error("Error fetching student details:", error);
    return res.status(500).json({
      error: "Failed to fetch student details",
    });
  }
};
