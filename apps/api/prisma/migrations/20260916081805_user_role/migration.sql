-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'SUPERADMIN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'CLIENT';

-- Enforce max one SUPERADMIN (partial unique index; a plain unique on
-- "role" would wrongly limit CLIENT to one row as well).
CREATE UNIQUE INDEX "User_single_superadmin" ON "User"("role") WHERE "role" = 'SUPERADMIN';
