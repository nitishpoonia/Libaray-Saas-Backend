import { Prisma } from "../generated/prisma/client";

export type Money = Prisma.Decimal;

export const money = (value: number | string | Prisma.Decimal): Money => new Prisma.Decimal(value);

/** Money in API responses: a number in rupees, rounded to paise. */
export const toRupees = (value: Money): number => Number(value.toFixed(2));
