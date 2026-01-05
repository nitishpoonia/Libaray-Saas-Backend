import { Request, Response } from "express";
import { prisma } from "../../utils/prisma";
import { Prisma } from "../../../generated/prisma";
import { error } from "console";

export const createExpense = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id)
      return res.status(401).json({
        error: "Unauthorized",
      });

    if (!req.body) {
      return res.status(400).json({ error: "Request body is required" });
    }

    const libraryId = Number(req.params.libraryId);
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const { title, category, amount, expense_date } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    if (!category?.trim()) {
      return res.status(400).json({ error: "Category is required" });
    }

    if (!amount || Number(amount) <= 0) {
      return res
        .status(400)
        .json({ error: "Amount must be greater than zero" });
    }

    const expenseDate = new Date(expense_date);

    if (isNaN(expenseDate.getTime())) {
      return res.status(400).json({ error: "Invalid expense date" });
    }

    if (expenseDate > new Date()) {
      return res
        .status(400)
        .json({ error: "Expense date cannot be in the future" });
    }

    await prisma.expenses.create({
      data: {
        title: title.trim(),
        category: category.trim(),
        amount: new Prisma.Decimal(amount),
        expense_date: expenseDate,
        library: {
          connect: { id: libraryId },
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: "Expense added successfully",
    });
  } catch (error) {
    console.error("Error creating the expense", error);
    return res.status(500).json({
      error: "Error creating the expense",
    });
  }
};

export const listAllExpenses = async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id)
      return res.status(401).json({
        error: "Unauthorized",
      });

    const libraryId = Number(req.params.libraryId);
    if (isNaN(libraryId)) {
      return res.status(400).json({ error: "Invalid library id" });
    }

    const expenses = await prisma.expenses.findMany({
      where: {
        library_id: libraryId,
      },
      orderBy: {
        expense_date: "desc",
      },
      select: {
        title: true,
        expense_date: true,
        category: true,
        amount: true,
      },
    });

    return res.status(200).json({
      status: true,
      expenses,
    });
  } catch (error) {
    console.error("Error get the list of expenses", error);
    res.status(500).json({
      error: "Error get the list of expenses",
    });
  }
};
