-- AlterTable
ALTER TABLE "User" ADD COLUMN "name" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarBytes" BYTEA;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarMime" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarUpdatedAt" TIMESTAMP(3);
