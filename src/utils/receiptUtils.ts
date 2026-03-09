import dayjs from "dayjs";
import { prisma } from "./prisma";

/**
 * Generates a unique receipt number in format: RCP-YYYYMMDD-XXXX
 * XXXX is a zero-padded count of payments made today (across all libraries)
 */
export const generateReceiptNumber = async (): Promise<string> => {
  const today = dayjs();
  const dateStr = today.format("YYYYMMDD");
  const startOfDay = today.startOf("day").toDate();
  const endOfDay = today.endOf("day").toDate();

  // Count payments already made today to get the next sequence number
  const todayPaymentsCount = await prisma.payments.count({
    where: {
      payment_date: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
  });

  const sequence = String(todayPaymentsCount + 1).padStart(4, "0");
  return `RCP-${dateStr}-${sequence}`;
};
