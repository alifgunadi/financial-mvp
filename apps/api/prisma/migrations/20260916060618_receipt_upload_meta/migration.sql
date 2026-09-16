/*
  Warnings:

  - Added the required column `originalName` to the `Receipt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `size` to the `Receipt` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "originalName" TEXT NOT NULL,
ADD COLUMN     "size" INTEGER NOT NULL;
