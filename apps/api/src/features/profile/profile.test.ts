// My Profile integration tests (node:test, real HTTP + database).
// The API runs as a child process (tsx) on a free port; it is killed in
// after(). Test-scoped fixtures only (example.invalid); rows are deleted
// in after(), scoped to the test user ids (net-zero).
// Run: node --import tsx --test src/features/profile/profile.test.ts
// Requires DATABASE_URL (uses the configured database, then cleans up).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../../shared/auth.js";
import { db } from "../../infra/db.js";

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
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
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
  return { status: res.status, json, headers: res.headers };
}

async function apiUpload(
  token: string | undefined,
  bytes: Buffer,
  filename: string,
  mime: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/profile/avatar`, {
    method: "POST",
    headers,
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function apiGetAvatar(token?: string): Promise<{
  status: number;
  bytes: Buffer;
  contentType: string | null;
}> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/profile/avatar`, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf, contentType: res.headers.get("content-type") };
}

const stamp = Date.now();
const testUserIds: string[] = [];

function testUsername(tag: string): string {
  const clean = tag.replace(/[^a-z0-9_]/g, "_").toLowerCase();
  return `${clean.slice(0, 6)}_${stamp}`;
}

async function makeUser(
  tag: string,
  password = `Test1234-${tag}-${stamp}`,
): Promise<{ id: string; email: string; password: string; token: string }> {
  const email = `prof-${tag}-${stamp}@example.invalid`;
  const created = await db.user.create({
    data: {
      email,
      username: testUsername(tag),
      passwordHash: await hashPassword(password),
      role: "CLIENT",
    },
  });
  testUserIds.push(created.id);
  const login = await api("POST", "/api/auth/login", undefined, {
    identifier: email,
    password,
  });
  assert.equal(login.status, 200);
  return { id: created.id, email, password, token: login.json.sessionToken as string };
}

async function login(email: string, password: string): Promise<string> {
  const res = await api("POST", "/api/auth/login", undefined, {
    identifier: email,
    password,
  });
  assert.equal(res.status, 200);
  return res.json.sessionToken as string;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const FAKE_PNG_BYTES = Buffer.from("not an image at all", "utf8");

before(async () => {
  const port = await freePort();
  server = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: path.join(API_DIR, "..", ".."),
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stderr?.on("data", () => {});
  await waitForReady(server);
  BASE = `http://127.0.0.1:${port}`;
});

after(async () => {
  await db.session.deleteMany({ where: { userId: { in: testUserIds } } });
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

describe("GET /api/profile", () => {
  it("returns profile without avatarBytes, 401 without token", async () => {
    const u = await makeUser("get");
    const res = await api("GET", "/api/profile", u.token);
    assert.equal(res.status, 200);
    assert.equal(res.json.id, u.id);
    assert.equal(res.json.email, u.email);
    assert.equal(res.json.role, "CLIENT");
    assert.ok(!("avatarBytes" in res.json));
    assert.equal(res.json.hasAvatar, false);
    assert.equal(res.json.avatarMime, null);
    const anon = await api("GET", "/api/profile");
    assert.equal(anon.status, 401);
  });
});

describe("PATCH /api/profile", () => {
  it("updates name, null clears, email/role are ignored", async () => {
    const u = await makeUser("patch");
    const updated = await api("PATCH", "/api/profile", u.token, {
      name: "  Budi  ",
      email: "hacked@example.invalid",
      role: "SUPERADMIN",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.name, "Budi");
    assert.equal(updated.json.email, u.email);
    assert.equal(updated.json.role, "CLIENT");
    const cleared = await api("PATCH", "/api/profile", u.token, { name: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.name, null);
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    assert.equal(row.email, u.email);
    assert.equal(row.role, "CLIENT");
  });

  it("empty name and too-long name -> 400", async () => {
    const u = await makeUser("patchbad");
    assert.equal((await api("PATCH", "/api/profile", u.token, { name: "   " })).status, 400);
    assert.equal(
      (await api("PATCH", "/api/profile", u.token, { name: "x".repeat(101) })).status,
      400,
    );
  });

  it("401 without token", async () => {
    assert.equal((await api("PATCH", "/api/profile", undefined, { name: "No" })).status, 401);
  });
});

describe("POST /api/profile/password", () => {
  it("wrong current password -> 400 (never 401), other session stays alive", async () => {
    const u = await makeUser("wrongpw");
    const second = await login(u.email, u.password);
    const res = await api("POST", "/api/profile/password", u.token, {
      currentPassword: "wrong-password-1",
      newPassword: "NewPassword123",
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "current password is incorrect");
    // Neither session was revoked: both still authenticate.
    assert.equal((await api("GET", "/api/profile", u.token)).status, 200);
    assert.equal((await api("GET", "/api/profile", second)).status, 200);
  });

  it("correct password -> 200, other sessions 401, current stays 200, new login works", async () => {
    const u = await makeUser("rightpw");
    const second = await login(u.email, u.password);
    const newPassword = `NewPass123-${stamp}`;
    const res = await api("POST", "/api/profile/password", u.token, {
      currentPassword: u.password,
      newPassword,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal((await api("GET", "/api/profile", u.token)).status, 200);
    assert.equal((await api("GET", "/api/profile", second)).status, 401);
    const fresh = await api("POST", "/api/auth/login", undefined, {
      identifier: u.email,
      password: newPassword,
    });
    assert.equal(fresh.status, 200);
    const stale = await api("POST", "/api/auth/login", undefined, {
      identifier: u.email,
      password: u.password,
    });
    assert.equal(stale.status, 401);
  });

  it("new == current -> 400", async () => {
    const u = await makeUser("samepw");
    const res = await api("POST", "/api/profile/password", u.token, {
      currentPassword: u.password,
      newPassword: u.password,
    });
    assert.equal(res.status, 400);
  });

  it("rate limit -> 429 + Retry-After; success resets the counter", async () => {
    const u = await makeUser("ratelimit");
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await api("POST", "/api/profile/password", u.token, {
            currentPassword: "wrong-password-1",
            newPassword: "NewPassword123",
          })
        ).status,
        400,
      );
    const limited = await api("POST", "/api/profile/password", u.token, {
      currentPassword: "wrong-password-1",
      newPassword: "NewPassword123",
    });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    // A fresh user proves success resets: 2 failures then success, then a
    // single failure is 400 again (not 429).
    const v = await makeUser("reset");
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await api("POST", "/api/profile/password", v.token, {
            currentPassword: "wrong-password-1",
            newPassword: "NewPassword123",
          })
        ).status,
        400,
      );
    const ok = await api("POST", "/api/profile/password", v.token, {
      currentPassword: v.password,
      newPassword: `ResetOk123-${stamp}`,
    });
    assert.equal(ok.status, 200);
    const again = await api("POST", "/api/profile/password", v.token, {
      currentPassword: "wrong-password-1",
      newPassword: "NewPassword123",
    });
    assert.equal(again.status, 400);
  });

  it("401 without token", async () => {
    const res = await api("POST", "/api/profile/password", undefined, {
      currentPassword: "x",
      newPassword: "NewPassword123",
    });
    assert.equal(res.status, 401);
  });
});

describe("avatar upload / download / delete", () => {
  it("wrong type -> 400, oversize -> 413, fake magic bytes -> 400", async () => {
    const u = await makeUser("avbad");
    const wrongType = await apiUpload(u.token, Buffer.from("hello"), "note.txt", "text/plain");
    assert.equal(wrongType.status, 400);
    const big = await apiUpload(u.token, Buffer.alloc(600 * 1024, 0), "big.png", "image/png");
    assert.equal(big.status, 413);
    const fake = await apiUpload(u.token, FAKE_PNG_BYTES, "fake.png", "image/png");
    assert.equal(fake.status, 400);
  });

  it("upload then GET returns identical bytes + content-type; DELETE then GET 404; double DELETE 200", async () => {
    const u = await makeUser("avok");
    const up = await apiUpload(u.token, PNG_BYTES, "avatar.png", "image/png");
    assert.equal(up.status, 200);
    assert.equal(up.json.mimeType, "image/png");
    const got = await apiGetAvatar(u.token);
    assert.equal(got.status, 200);
    assert.equal(got.contentType, "image/png");
    assert.deepEqual(got.bytes, PNG_BYTES);
    const profile = await api("GET", "/api/profile", u.token);
    assert.equal(profile.json.hasAvatar, true);
    assert.equal(profile.json.avatarMime, "image/png");
    const del = await api("DELETE", "/api/profile/avatar", u.token);
    assert.equal(del.status, 200);
    assert.equal((await apiGetAvatar(u.token)).status, 404);
    const delAgain = await api("DELETE", "/api/profile/avatar", u.token);
    assert.equal(delAgain.status, 200);
  });

  it("user A cannot see user B avatar (scoped to caller, no id param)", async () => {
    const a = await makeUser("ava");
    const b = await makeUser("avb");
    assert.equal((await apiUpload(a.token, PNG_BYTES, "a.png", "image/png")).status, 200);
    // B has no avatar of its own: its view is empty, never A's bytes.
    assert.equal((await apiGetAvatar(b.token)).status, 404);
    const bProfile = await api("GET", "/api/profile", b.token);
    assert.equal(bProfile.json.hasAvatar, false);
    const aProfile = await api("GET", "/api/profile", a.token);
    assert.equal(aProfile.json.hasAvatar, true);
  });

  it("401 without token on all avatar endpoints", async () => {
    assert.equal((await apiGetAvatar(undefined)).status, 401);
    assert.equal((await api("DELETE", "/api/profile/avatar")).status, 401);
    assert.equal((await apiUpload(undefined, PNG_BYTES, "a.png", "image/png")).status, 401);
  });
});
