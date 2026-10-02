// One-off SUPERADMIN promotion for a pre-existing account (Case B).
// Run AFTER the user_role migration, while logged-out traffic is idle:
//   npx tsx scripts/promote-superadmin.ts <email>
//
// Rules: email is lowercased+trimmed before compare; target user must exist;
// no other SUPERADMIN may exist; refuses to run otherwise. Takes no
// passwords, creates nothing, deletes nothing.
import { z } from "zod";
import { db } from "../src/db.js";
import { env } from "../src/env.js";

const superadminEmail = env.SUPERADMIN_EMAIL;
if (!superadminEmail) {
  console.error("refused: SUPERADMIN_EMAIL is not set");
  await db.$disconnect();
  process.exit(1);
}

const email = z.string().trim().toLowerCase().email().parse(process.argv[2]);

if (email !== superadminEmail) {
  console.error(`refused: only ${superadminEmail} is eligible for SUPERADMIN`);
  await db.$disconnect();
  process.exit(1);
}

const target = await db.user.findUnique({ where: { email } });
if (!target) {
  console.error(`user not found: ${email}`);
  await db.$disconnect();
  process.exit(1);
}
if (target.role === "SUPERADMIN") {
  console.log(`already SUPERADMIN: ${email}, nothing to do.`);
  await db.$disconnect();
  process.exit(0);
}

const other = await db.user.findFirst({
  where: { role: "SUPERADMIN", id: { not: target.id } },
});
if (other) {
  console.error("refused: another SUPERADMIN already exists.");
  await db.$disconnect();
  process.exit(1);
}

await db.user.update({ where: { id: target.id }, data: { role: "SUPERADMIN" } });
console.log(`promoted to SUPERADMIN: ${email}`);
await db.$disconnect();
