import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client";
import { fromDbDate, monthRange, todayIn, toDbDate } from "../../lib/dates";
import { badRequest, notFound } from "../../lib/errors";
import { pageMeta, sendData } from "../../lib/http";
import { money, toRupees } from "../../lib/money";
import { prisma } from "../../lib/prisma";
import { id, isoDate, pagination, positiveRupees } from "../../lib/validation";
import { requireAccess, requireRole, requireUser } from "../../middleware/libraryAccess";
import { requireActiveSubscription } from "../../middleware/subscription";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

const fields = {
  title: z.string().trim().min(1).max(100),
  category: z.string().trim().min(1).max(50),
  amount: positiveRupees,
  spentOn: isoDate,
  notes: z.string().trim().max(500).optional(),
};

const createBody = z.object(fields);
const updateBody = z
  .object({
    title: fields.title.optional(),
    category: fields.category.optional(),
    amount: fields.amount.optional(),
    spentOn: fields.spentOn.optional(),
    notes: fields.notes,
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to update");

const listQuery = pagination.extend({
  month: month.optional(),
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
});

type ExpenseRow = {
  id: number;
  title: string;
  category: string;
  amount: Prisma.Decimal;
  spentOn: Date;
  notes: string | null;
  createdAt: Date;
};

const view = (e: ExpenseRow) => ({
  id: e.id,
  title: e.title,
  category: e.category,
  amount: toRupees(e.amount),
  spentOn: fromDbDate(e.spentOn),
  notes: e.notes,
  createdAt: e.createdAt,
});

function assertNotFuture(spentOn: string, timezone: string) {
  if (spentOn > todayIn(timezone)) {
    throw badRequest("Expense date can't be in the future", "FUTURE_DATE");
  }
}

async function list(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const query = listQuery.parse(req.query);
  const range = query.month ? monthRange(query.month) : null;

  const where: Prisma.ExpenseWhereInput = {
    libraryId: library.id,
    ...(range ? { spentOn: { gte: toDbDate(range.first), lte: toDbDate(range.last) } } : {}),
    ...(query.search ? { title: { contains: query.search, mode: "insensitive" } } : {}),
    ...(query.category ? { category: { equals: query.category, mode: "insensitive" } } : {}),
  };

  const [expenses, total, sum] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: [{ spentOn: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.expense.count({ where }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);

  sendData(res, expenses.map(view), {
    ...pageMeta(query.page, query.limit, total),
    totalAmount: toRupees(money(sum._sum.amount ?? 0)),
  });
}

async function create(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const body = createBody.parse(req.body);
  assertNotFuture(body.spentOn, library.timezone);
  const expense = await prisma.expense.create({
    data: {
      libraryId: library.id,
      ...body,
      amount: money(body.amount),
      spentOn: toDbDate(body.spentOn),
      recordedById: requireUser(req).id,
    },
  });
  sendData(res, view(expense), undefined, 201);
}

async function update(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const expenseId = id.parse(req.params.expenseId);
  const body = updateBody.parse(req.body);
  if (body.spentOn) assertNotFuture(body.spentOn, library.timezone);

  const { count } = await prisma.expense.updateMany({
    where: { id: expenseId, libraryId: library.id },
    data: {
      ...body,
      amount: body.amount === undefined ? undefined : money(body.amount),
      spentOn: body.spentOn === undefined ? undefined : toDbDate(body.spentOn),
    },
  });
  if (!count) throw notFound("Expense not found", "EXPENSE_NOT_FOUND");
  sendData(res, view(await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } })));
}

async function remove(req: Request, res: Response) {
  const { library } = requireAccess(req);
  const expenseId = id.parse(req.params.expenseId);
  const { count } = await prisma.expense.deleteMany({ where: { id: expenseId, libraryId: library.id } });
  if (!count) throw notFound("Expense not found", "EXPENSE_NOT_FOUND");
  res.status(204).end();
}

const router = Router({ mergeParams: true });
router.use(requireRole("MANAGER"));
router.get("/", list);
router.post("/", requireActiveSubscription, create);
router.patch("/:expenseId", requireActiveSubscription, update);
router.delete("/:expenseId", requireActiveSubscription, remove);

export default router;
