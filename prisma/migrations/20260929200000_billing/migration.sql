-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SUBSCRIPTION_REMINDER';

-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "BillingKind" AS ENUM ('PLAN', 'BRANCH_ADDON');

-- CreateEnum
CREATE TYPE "BillingPaymentStatus" AS ENUM ('CREATED', 'PAID');

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" SERIAL NOT NULL,
    "organization_id" INTEGER NOT NULL,
    "kind" "BillingKind" NOT NULL,
    "plan" "BillingPlan",
    "months" INTEGER,
    "branches" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "razorpay_order_id" TEXT NOT NULL,
    "razorpay_payment_id" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_payments_amount_positive" CHECK ("amount_paise" > 0),
    CONSTRAINT "subscription_payments_branches_positive" CHECK ("branches" >= 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_razorpay_order_id_key" ON "subscription_payments"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_razorpay_payment_id_key" ON "subscription_payments"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "subscription_payments_organization_id_created_at_idx" ON "subscription_payments"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
