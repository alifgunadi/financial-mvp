// One-off username backfill for pre-existing accounts (Stage A).
// Run AFTER the username_nullable migration, while logged-out traffic is idle:
//   Dry run (default, no writes):
//     npx tsx scripts/backfill-username.ts
//   Apply:
//     npx tsx scripts/backfill-username.ts --yes
//
// Rules: usernames are lowercase [a-z0-9_], 3-20 chars, derived from the
// email local-part (deterministic: createdAt ASC, id ASC). Reserved names
// get a "_1" suffix before normal dedupe. Anything that is not a valid
// username (NULL, empty, wrong charset/length, reserved) is backfilled;
// valid usernames are never touched. Dry run prints the full plan
// and writes nothing. Takes no passwords, creates no users, deletes nothing.
import { db } from "../src/infra/db.js";
import { env } from "../src/infra/env.js";

// Reserved names (checked case-insensitively, after normalization which
// already lowercases, so this list stays lowercase-only).
const RESERVED = new Set([
  "admin",
  "root",
  "superadmin",
  "support",
  "api",
  "null",
  "undefined",
]);

const MAX_LEN = 20;

// Single definition of "needs backfill", shared by target selection,
// dry-run, apply, and final verification: NULL, empty, or anything
// outside lowercase [a-z0-9_] 3-20 chars (reserved words included,
// since the generator below never emits a bare reserved word).
function isValidUsername(u: string | null): u is string {
  return (
    typeof u === "string" && /^[a-z0-9_]{3,20}$/.test(u) && !RESERVED.has(u)
  );
}

function baseFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = (at === -1 ? email : email.slice(0, at)).toLowerCase();
  let base = local
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, MAX_LEN);
  if (base === "") base = "user";
  if (base.length < 3) base = base.padEnd(3, "0");
  return base;
}

function withSuffix(base: string, n: number): string {
  const suffix = `_${n}`;
  return base.slice(0, MAX_LEN - suffix.length) + suffix;
}

function pickUsername(base: string, taken: Set<string>): string {
  let candidate = RESERVED.has(base) ? withSuffix(base, 1) : base;
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  candidate = withSuffix(base, n);
  while (taken.has(candidate)) {
    n += 1;
    candidate = withSuffix(base, n);
  }
  return candidate;
}

const apply = process.argv.includes("--yes");

// Safe target label: hostname + database only, never credentials.
// Unknown when unparsable; never logs the raw URL and never crashes here.
let dbTarget = "unknown";
try {
  const u = new URL(env.DATABASE_URL);
  if (u.hostname) dbTarget = `${u.hostname}${u.pathname && u.pathname !== "/" ? u.pathname : ""}`;
} catch {
  dbTarget = "unknown";
}
console.log(`target database: ${dbTarget}`);

try {
  // Fetch all users once: Prisma cannot express the full validity rule
  // in a WHERE clause, so target selection reuses isValidUsername here
  // instead of a narrower `username: null` filter (which would miss "").
  const all = await db.user.findMany({
    select: { id: true, email: true, username: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // Uniqueness counts every stored value (valid or not), lowercased, so a
  // generated name can never collide with anything present during the run.
  const taken = new Set(
    all
      .map((u) => u.username)
      .filter((u): u is string => u !== null)
      .map((u) => u.toLowerCase()),
  );
  const plan = all
    .filter((u) => !isValidUsername(u.username))
    .map((u) => {
      const username = pickUsername(baseFromEmail(u.email), taken);
      taken.add(username);
      return { id: u.id, email: u.email, username };
    });

  if (!apply) {
    for (const p of plan) console.log(`${p.email} -> ${p.username}`);
    console.log(`plan: ${plan.length} user(s) to backfill.`);
    console.log("DRY RUN: no changes made. Rerun with --yes to apply.");
  } else {
    let done = 0;
    for (const p of plan) {
      await db.user.update({ where: { id: p.id }, data: { username: p.username } });
      done += 1;
      if (done % 100 === 0 || done === plan.length)
        console.log(`progress: ${done}/${plan.length}`);
    }
    console.log(`applied: ${done} user(s) backfilled.`);
  }

  // Same predicate as target selection: counts NULL, empty, and any
  // other invalid value (a bare `username: null` count would miss "").
  const recheck = await db.user.findMany({ select: { username: true } });
  const remaining = recheck.filter((u) => !isValidUsername(u.username)).length;
  console.log(`remaining without valid username: ${remaining}`);
  await db.$disconnect();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  await db.$disconnect();
  process.exit(1);
}
