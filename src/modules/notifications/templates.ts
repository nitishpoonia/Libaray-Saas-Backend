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

/**
 * Student texts, written exactly as they get registered on the DLT portal.
 * `{#var#}` is DLT's placeholder; providers (MSG91, Gupshup...) send a template id plus
 * the values in order, and the operator matches the result against the registered text.
 * Changing a wording here means registering the new text first.
 */
export const TEXT_TEMPLATES = {
  // library, student, seat, timing, end date, held-until date
  OVERDUE_NOTICE:
    "{#var#}: Hi {#var#}, your membership (seat {#var#}, {#var#}) ended on {#var#}. " +
    "Your seat is held until {#var#}. Renew to keep it.",
  // same as above + pending amount
  OVERDUE_NOTICE_WITH_DUES:
    "{#var#}: Hi {#var#}, your membership (seat {#var#}, {#var#}) ended on {#var#}. " +
    "Your seat is held until {#var#}. Renew to keep it. Pending fees: {#var#}.",
  // library, student, cancel date, seat
  CANCELLATION_WARNING:
    "{#var#}: Hi {#var#}, your membership will be cancelled tomorrow ({#var#}) " +
    "and seat {#var#} released. Renew today to keep it.",
} as const;

export type TextTemplate = keyof typeof TEXT_TEMPLATES;

/** What a text sender gets: the template and its values, plus the filled text for logs. */
export type TextMessage = { template: TextTemplate; vars: string[]; text: string };

function textMessage(template: TextTemplate, vars: string[]): TextMessage {
  const body = TEXT_TEMPLATES[template];
  const slots = body.split("{#var#}").length - 1;
  if (slots !== vars.length) {
    throw new Error(`${template} has ${slots} placeholders but got ${vars.length} values`);
  }
  let i = 0;
  return { template, vars, text: body.replace(/\{#var#\}/g, () => vars[i++]!) };
}

export function overdueNotice(p: Period): TextMessage {
  const vars = [
    p.libraryName,
    p.studentName,
    p.seatLabel,
    formatSlot(p),
    dayMonth(p.endDate),
    dayMonth(p.graceEndsOn),
  ];
  return p.pendingAmount > 0
    ? textMessage("OVERDUE_NOTICE_WITH_DUES", [...vars, rupees(p.pendingAmount)])
    : textMessage("OVERDUE_NOTICE", vars);
}

export function cancellationWarning(p: Period & { cancelDate: string }): TextMessage {
  return textMessage("CANCELLATION_WARNING", [
    p.libraryName,
    p.studentName,
    dayMonth(p.cancelDate),
    p.seatLabel,
  ]);
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
