-- CreateTable
CREATE TABLE "ExtractionAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractionAttempt_userId_createdAt_idx" ON "ExtractionAttempt"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ExtractionAttempt" ADD CONSTRAINT "ExtractionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
