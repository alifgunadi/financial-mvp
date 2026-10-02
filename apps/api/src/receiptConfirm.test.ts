// Receipt confirm integration tests (node:test, real HTTP + database).
// The API runs as a child process (tsx) on a free port; it is killed in
// after(). Test-scoped fixtures only (example.invalid); rows are deleted
// in after(), scoped to the test user ids (net-zero).
// Run: node --import tsx --test src/receiptConfirm.test.ts
// Requires DATABASE_URL (uses the configured database, then cleans up).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./auth.js";
import { db } from "./db.js";
import { receiptFilePath, saveReceiptFile } from "./receiptStore.js";

const API_DIR = path.dirname(fileURLToPath(import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 30000);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("api listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`server exited with code ${code}`));
      }
    });
  });
}

let BASE = "";
let server: ChildProcess | null = null;

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

const stamp = Date.now();
const testUserIds: string[] = [];
let tokenA = "";
let tokenB = "";
let expCatA = "";
let incCatA = "";
let expCatB = "";

async function makeUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `rcpt-${tag}-${stamp}@example.invalid`;
  const password = `Test1234-${tag}-${stamp}`;
  const created = await db.user.create({
    data: { email, passwordHash: await hashPassword(password), role: "CLIENT" },
  });
  testUserIds.push(created.id);
  const login = await api("POST", "/api/auth/login", undefined, { email, password });
  assert.equal(login.status, 200);
  return { id: created.id, token: login.json.sessionToken as string };
}

async function makeCategory(userId: string, name: string, type: "INCOME" | "EXPENSE") {
  return db.category.create({ data: { name: `${name}-${stamp}`, type, userId } });
}

async function makeReceipt(
  userId: string,
  overrides: {
    amount?: bigint | null;
    type?: "INCOME" | "EXPENSE" | null;
    date?: Date | null;
    categoryId?: string | null;
    createdAt?: Date;
    filePath?: string;
  } = {},
) {
  return db.receipt.create({
    data: {
      filePath: overrides.filePath ?? "uploads/test.jpg",
      originalName: "test.jpg",
      mimeType: "image/jpeg",
      size: 10,
      userId,
      status: "NEEDS_REVIEW",
      extractedAmount: overrides.amount === undefined ? 50000n : overrides.amount,
      extractedType: overrides.type === undefined ? "EXPENSE" : overrides.type,
      extractedDate:
        overrides.date === undefined ? new Date("2026-09-05T00:00:00Z") : overrides.date,
      extractedMerchant: "TEST MERCHANT",
      suggestedCategoryId:
        overrides.categoryId === undefined ? expCatA : overrides.categoryId,
      extractedAt: new Date(),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

before(async () => {
  const port = await freePort();
  server = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: path.join(API_DIR, ".."),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stderr?.on("data", () => {});
  await waitForReady(server);
  BASE = `http://127.0.0.1:${port}`;
  const a = await makeUser("a");
  const b = await makeUser("b");
  tokenA = a.token;
  tokenB = b.token;
  expCatA = (await makeCategory(a.id, "RCExpA", "EXPENSE")).id;
  incCatA = (await makeCategory(a.id, "RCIncA", "INCOME")).id;
  expCatB = (await makeCategory(b.id, "RCExpB", "EXPENSE")).id;
});

after(async () => {
  await db.transaction.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.receipt.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.session.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.category.deleteMany({ where: { userId: { in: testUserIds } } });
  await db.user.deleteMany({ where: { id: { in: testUserIds } } });
  await db.$disconnect();
  if (server) {
    server.kill();
    await new Promise<void>((resolve) => {
      if (server?.exitCode !== null) resolve();
      else server?.once("exit", () => resolve());
    });
  }
});

describe("POST /api/receipts/:id/confirm", () => {
  it("happy path: 201, RECEIPT transaction linked, receipt CONFIRMED", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const res = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(res.status, 201);
    const tx = res.json.transaction as Record<string, unknown>;
    assert.equal((tx.category as Record<string, unknown>).id, expCatA);
    assert.equal(tx.merchant, "TEST MERCHANT");
    assert.equal(res.json.receipt && (res.json.receipt as Record<string, unknown>).status, "confirmed");
    const rows = await db.transaction.findMany({ where: { receiptId: receipt.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "RECEIPT");
    assert.equal(rows[0].userId, user.id);
    assert.equal(rows[0].categoryId, expCatA);
    assert.equal(rows[0].amount, 50000n);
    const updated = await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    assert.equal(updated.status, "CONFIRMED");
  });

  it("incomplete review (each missing field) -> 400", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const cases = [
      await makeReceipt(user.id, { amount: null }),
      await makeReceipt(user.id, { type: null }),
      await makeReceipt(user.id, { date: null }),
      await makeReceipt(user.id, { categoryId: null }),
    ];
    for (const receipt of cases) {
      const res = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "receipt review incomplete");
    }
  });

  it("foreign category -> 400 category not found", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id, { categoryId: expCatB });
    const res = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "category not found");
  });

  it("type mismatch (expense + income category) -> 400", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id, { categoryId: incCatA });
    const res = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "category type mismatch");
  });

  it("other user's receipt -> 404", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const res = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenB);
    assert.equal(res.status, 404);
  });

  it("sequential double confirm -> 201 then 409, exactly one transaction", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const first = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(first.status, 201);
    const second = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(second.status, 409);
    assert.equal(second.json.error, "receipt already confirmed");
    const rows = await db.transaction.findMany({ where: { receiptId: receipt.id } });
    assert.equal(rows.length, 1);
  });

  it("concurrent confirm -> one 201 and one 409, exactly one transaction", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const [r1, r2] = await Promise.all([
      api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA),
      api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
    const rows = await db.transaction.findMany({ where: { receiptId: receipt.id } });
    assert.equal(rows.length, 1);
    const updated = await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    assert.equal(updated.status, "CONFIRMED");
  });

  it("malformed id -> 400, unknown id -> 404", async () => {
    const bad = await api("POST", "/api/receipts/not-a-uuid/confirm", tokenA);
    assert.equal(bad.status, 400);
    const missing = await api(
      "POST",
      "/api/receipts/00000000-0000-4000-8000-000000000000/confirm",
      tokenA,
    );
    assert.equal(missing.status, 404);
  });
});

describe("PUT /api/receipts/:id (save-and-confirm)", () => {
  async function userA() {
    return db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
  }

  it("complete save -> 200, transaction created, receipt CONFIRMED", async () => {
    const user = await userA();
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const res = await api("PUT", `/api/receipts/${receipt.id}`, tokenA, {
      amount: 50000,
      date: "2026-09-05",
      merchant: "TEST MERCHANT",
      type: "expense",
      categoryId: expCatA,
    });
    assert.equal(res.status, 200);
    assert.equal((res.json.receipt as Record<string, unknown>).status, "confirmed");
    assert.ok(res.json.transaction !== null);
    const rows = await db.transaction.findMany({ where: { receiptId: receipt.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "RECEIPT");
    assert.equal(rows[0].categoryId, expCatA);
  });

  it("incomplete save -> 200, transaction null, stays NEEDS_REVIEW", async () => {
    const user = await userA();
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const res = await api("PUT", `/api/receipts/${receipt.id}`, tokenA, {
      merchant: "STILL INCOMPLETE",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.transaction, null);
    assert.equal((res.json.receipt as Record<string, unknown>).status, "needs_review");
    assert.equal(
      (await db.transaction.findMany({ where: { receiptId: receipt.id } })).length,
      0,
    );
  });

  it("double complete save -> 200 then 409, exactly one transaction", async () => {
    const user = await userA();
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const body = {
      amount: 50000,
      date: "2026-09-05",
      merchant: "TEST MERCHANT",
      type: "expense",
      categoryId: expCatA,
    };
    const first = await api("PUT", `/api/receipts/${receipt.id}`, tokenA, body);
    assert.equal(first.status, 200);
    assert.ok(first.json.transaction !== null);
    const second = await api("PUT", `/api/receipts/${receipt.id}`, tokenA, body);
    assert.equal(second.status, 409);
    assert.equal(
      (await db.transaction.findMany({ where: { receiptId: receipt.id } })).length,
      1,
    );
  });

  it("concurrent complete saves -> one transaction", async () => {
    const user = await userA();
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const body = {
      amount: 50000,
      date: "2026-09-05",
      merchant: "TEST MERCHANT",
      type: "expense",
      categoryId: expCatA,
    };
    const [r1, r2] = await Promise.all([
      api("PUT", `/api/receipts/${receipt.id}`, tokenA, body),
      api("PUT", `/api/receipts/${receipt.id}`, tokenA, body),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(
      (await db.transaction.findMany({ where: { receiptId: receipt.id } })).length,
      1,
    );
  });

  it("mismatched category via save -> 400, no transaction", async () => {
    const user = await userA();
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const res = await api("PUT", `/api/receipts/${receipt.id}`, tokenA, {
      amount: 50000,
      date: "2026-09-05",
      type: "expense",
      categoryId: incCatA,
    });
    assert.equal(res.status, 400);
    assert.equal(
      (await db.transaction.findMany({ where: { receiptId: receipt.id } })).length,
      0,
    );
  });
});

describe("GET /api/receipts/latest", () => {
  it("returns only the newest NEEDS_REVIEW row", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const old = await makeReceipt(user.id, {
      categoryId: null,
      createdAt: new Date(Date.now() - 3600_000),
    });
    const fresh = await makeReceipt(user.id, { categoryId: null });
    assert.notEqual(old.id, fresh.id);
    const res = await api("GET", "/api/receipts/latest", tokenA);
    assert.equal(res.status, 200);
    assert.equal((res.json.receipt as Record<string, unknown>).id, fresh.id);
  });

  it("isolation: another user sees null", async () => {
    const res = await api("GET", "/api/receipts/latest", tokenB);
    assert.equal(res.status, 200);
    assert.equal(res.json.receipt, null);
  });

  it("empty inbox -> 200 null", async () => {
    const c = await makeUser("c");
    const res = await api("GET", "/api/receipts/latest", c.token);
    assert.equal(res.status, 200);
    assert.equal(res.json.receipt, null);
  });

  it("CONFIRMED rows are skipped", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const confirmed = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(confirmed.status, 201);
    const res = await api("GET", "/api/receipts/latest", tokenA);
    assert.equal(res.status, 200);
    const latest = res.json.receipt as Record<string, unknown> | null;
    assert.ok(latest === null || latest.status === "needs_review");
    if (latest) assert.notEqual(latest.id, receipt.id);
  });
});

describe("DELETE /api/receipts/:id", () => {
  it("deletes NEEDS_REVIEW row and its stored file", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const stored = await saveReceiptFile(".jpg", Buffer.from("test-bytes"));
    const receipt = await makeReceipt(user.id, {
      categoryId: null,
      filePath: `uploads/${stored}`,
    });
    const res = await api("DELETE", `/api/receipts/${receipt.id}`, tokenA);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(await db.receipt.findUnique({ where: { id: receipt.id } }), null);
    assert.equal(existsSync(receiptFilePath(stored)), false);
    const gone = await api("GET", `/api/receipts/${receipt.id}`, tokenA);
    assert.equal(gone.status, 404);
  });

  it("CONFIRMED receipt -> 409, transaction intact", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id);
    const confirmed = await api("POST", `/api/receipts/${receipt.id}/confirm`, tokenA);
    assert.equal(confirmed.status, 201);
    const res = await api("DELETE", `/api/receipts/${receipt.id}`, tokenA);
    assert.equal(res.status, 409);
    assert.equal(
      (await db.transaction.findMany({ where: { receiptId: receipt.id } })).length,
      1,
    );
    assert.equal((await db.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).status, "CONFIRMED");
  });

  it("foreign receipt -> 404", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id, { categoryId: null });
    const res = await api("DELETE", `/api/receipts/${receipt.id}`, tokenB);
    assert.equal(res.status, 404);
    assert.notEqual(await db.receipt.findUnique({ where: { id: receipt.id } }), null);
  });

  it("double delete -> 200 then 404", async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: `rcpt-a-${stamp}@example.invalid` } });
    const receipt = await makeReceipt(user.id, { categoryId: null });
    assert.equal((await api("DELETE", `/api/receipts/${receipt.id}`, tokenA)).status, 200);
    const second = await api("DELETE", `/api/receipts/${receipt.id}`, tokenA);
    assert.equal(second.status, 404);
  });

  it("malformed id -> 400", async () => {
    assert.equal((await api("DELETE", "/api/receipts/not-a-uuid", tokenA)).status, 400);
  });
});
