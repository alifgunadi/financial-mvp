// One-off orphan claim (Opsi A). Run AFTER the owner registers normally:
//   Dry run (default, no writes):
//     npx tsx scripts/claim-orphans.ts <userId>
//   Apply:
//     npx tsx scripts/claim-orphans.ts <userId> --yes
//
// Rules: userId must be a valid UUID of an existing user; only rows with
// userId IS NULL are touched (never overwrites existing ownership);
// everything runs in one transaction; exits non-zero if post-check fails.
// Creates nothing, deletes nothing, takes no passwords or secrets.
import { z } from "zod";
import { db } from "../src/infra/db.js";

const apply = process.argv.includes("--yes");

const userId = z.string().uuid("usage: tsx scripts/claim-orphans.ts <userId>").parse(process.argv[2]);

const user = await db.user.findUnique({ where: { id: userId } });
if (!user) {
  console.error(`user not found: ${userId}`);
  await db.$disconnect();
  process.exit(1);
}

const orphans = {
  categories: await db.category.count({ where: { userId: null } }),
  transactions: await db.transaction.count({ where: { userId: null } }),
  receipts: await db.receipt.count({ where: { userId: null } }),
};
console.log(`orphans: ${JSON.stringify(orphans)} (owner: ${user.email})`);

// Safe target label: hostname + database only, never credentials.
// Unknown when unparsable; never logs the raw URL and never crashes here.
let dbTarget = "unknown";
try {
  const u = new URL(process.env.DATABASE_URL ?? "");
  if (u.hostname) dbTarget = `${u.hostname}${u.pathname && u.pathname !== "/" ? u.pathname : ""}`;
} catch {
  dbTarget = "unknown";
}
console.log(`target database: ${dbTarget}`);

const total = orphans.categories + orphans.transactions + orphans.receipts;
if (total === 0) {
  console.log("nothing to claim, no updates made.");
  await db.$disconnect();
  process.exit(0);
}

if (!apply) {
  console.log(`DRY RUN: would claim ${total} row(s) for ${user.email}. No changes made. Rerun with --yes to apply.`);
  await db.$disconnect();
  process.exit(0);
}

await db.$transaction([
  db.category.updateMany({ where: { userId: null }, data: { userId } }),
  db.transaction.updateMany({ where: { userId: null }, data: { userId } }),
  db.receipt.updateMany({ where: { userId: null }, data: { userId } }),
]);

const remaining = {
  categories: await db.category.count({ where: { userId: null } }),
  transactions: await db.transaction.count({ where: { userId: null } }),
  receipts: await db.receipt.count({ where: { userId: null } }),
};
if (remaining.categories + remaining.transactions + remaining.receipts > 0) {
  console.error(`verification FAILED, orphans remain: ${JSON.stringify(remaining)}`);
  await db.$disconnect();
  process.exit(1);
}
console.log(`claimed ${total} row(s) for ${user.email}, verification passed.`);
await db.$disconnect();
