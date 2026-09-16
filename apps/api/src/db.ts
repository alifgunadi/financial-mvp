import { PrismaClient } from "@prisma/client";

// Single shared client (Next/Express best practice: one instance per process).
export const db = new PrismaClient();
