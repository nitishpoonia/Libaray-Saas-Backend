import { formatSlot } from "../memberships/slots";

/**
 * Message texts. Kept short: an SMS is 160 characters per part, and Indian SMS / WhatsApp
 * providers need these registered as templates, so wording changes should be rare.
 */

type Period = {
  studentName: string;
  libraryName: string;
  seatLabel: string;
  startMinute: number;
  endMinute: number;
  endDate: string;
  graceEndsOn: string;
  pendingAmount: number;
};

const dayMonth = (iso: string) => {
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d)} ${months[Number(m) - 1]}`;
};

const rupees = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;

export function overdueNotice(p: Period): string {
  const dues = p.pendingAmount > 0 ? ` Pending fees: ${rupees(p.pendingAmount)}.` : "";
  return (
    `${p.libraryName}: Hi ${p.studentName}, your membership (seat ${p.seatLabel}, ` +
    `${formatSlot(p)}) ended on ${dayMonth(p.endDate)}. Your seat is held until ` +
    `${dayMonth(p.graceEndsOn)}. Renew to keep it.${dues}`
  );
}

export function cancellationWarning(p: Period & { cancelDate: string }): string {
  return (
    `${p.libraryName}: Hi ${p.studentName}, your membership will be cancelled tomorrow ` +
    `(${dayMonth(p.cancelDate)}) and seat ${p.seatLabel} released. Renew today to keep it.`
  );
}

export type DigestInput = {
  libraryName: string;
  cancelTomorrow: string[];
  newlyCancelled: string[];
  overdueCount: number;
  endingSoonCount: number;
  endingSoonFees: number;
  pendingFees: number;
};

/** The owner's daily push. Returns null when there's nothing worth a notification. */
export function dailyDigest(d: DigestInput): { title: string; body: string } | null {
  const lines: string[] = [];
  if (d.cancelTomorrow.length) {
    lines.push(`Cancelled tomorrow unless renewed: ${d.cancelTomorrow.join(", ")}`);
  }
  if (d.newlyCancelled.length) {
    lines.push(`Cancelled, seat freed: ${d.newlyCancelled.join(", ")}`);
  }
  if (d.overdueCount) lines.push(`${d.overdueCount} overdue`);
  if (d.endingSoonCount) {
    lines.push(`${d.endingSoonCount} ending in 3 days (${rupees(d.endingSoonFees)} in renewals)`);
  }
  if (d.pendingFees > 0) lines.push(`${rupees(d.pendingFees)} fees pending`);
  if (lines.length === 0) return null;
  return { title: `${d.libraryName}: today`, body: lines.join(" · ") };
}
