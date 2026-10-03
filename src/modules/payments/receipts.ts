import type { IsoDate } from "../../lib/dates";
import { prisma } from "../../lib/prisma";
import { membershipView } from "../memberships/service";
import { paymentView } from "./service";

/** Everything the app needs to render or share a receipt. */
export async function receiptFor(
  library: { id: number; name: string },
  paymentId: number,
  today: IsoDate,
) {
  const [payment, details] = await Promise.all([
    prisma.payment.findFirstOrThrow({
      where: { id: paymentId, libraryId: library.id },
      include: {
        student: { select: { name: true, phone: true } },
        membership: { include: { seat: { select: { label: true } } } },
      },
    }),
    prisma.library.findUniqueOrThrow({ where: { id: library.id }, select: { name: true, address: true } }),
  ]);
  const period = membershipView(payment.membership, today);

  return {
    ...paymentView(payment),
    libraryName: details.name,
    libraryAddress: details.address,
    studentName: payment.student.name,
    studentPhone: payment.student.phone,
    seatLabel: period.seatLabel,
    timing: period.timing,
    periodStart: period.startDate,
    periodEnd: period.endDate,
    fee: period.fee,
    totalPaid: period.amountPaid,
    pendingAmount: period.pendingAmount,
  };
}
