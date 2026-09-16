/*
  Warnings:

  - You are about to alter the column `extractedAmount` on the `Receipt` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `BigInt`.
  - You are about to alter the column `amount` on the `Transaction` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `BigInt`.

*/
-- AlterTable
ALTER TABLE "Receipt" ALTER COLUMN "extractedAmount" SET DATA TYPE BIGINT USING "extractedAmount"::BIGINT;

-- AlterTable
ALTER TABLE "Transaction" ALTER COLUMN "amount" SET DATA TYPE BIGINT USING "amount"::BIGINT;
