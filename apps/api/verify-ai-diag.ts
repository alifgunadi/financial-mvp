// TEMP verification harness (deleted after run). Stubs only the AI provider
// endpoint; harness<->server traffic uses the real fetch.
process.env.PORT = "3121";

const realFetch = globalThis.fetch;
let stub: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
let providerCalls = 0;
globalThis.fetch = ((url: unknown, init?: RequestInit) => {
  if (String(url).includes("generativelanguage.googleapis.com")) {
    providerCalls++;
    if (!stub) throw new Error("provider stub not set");
    return stub(String(url), init ?? {});
  }
  return realFetch(url as string, init);
}) as typeof fetch;

const BASE = "http://localhost:3121";
const { db } = await import("./src/db.js");
await import("./src/index.js");

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await realFetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not boot");
}

let pass = 0;
let total = 0;
const check = (name: string, cond: boolean, extra = "") => {
  total++;
  if (cond) { pass++; console.log(`T: ok   - ${name}`); }
  else console.log(`T: FAIL - ${name} ${extra}`);
};

const J = (o: unknown) => JSON.stringify(o);
async function req(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await realFetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? J(opts.body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, setCookie: res.headers.get("set-cookie") ?? "" };
}

const IMG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
async function upload(cookie: string) {
  const f = new FormData();
  f.append("file", new Blob([IMG], { type: "image/jpeg" }), "r.jpg");
  const r = await realFetch(`${BASE}/api/receipts`, { method: "POST", headers: { Cookie: cookie }, body: f });
  const body = (await r.json().catch(() => null)) as { id?: string } | null;
  return { status: r.status, id: body?.id ?? "" };
}
async function extract(cookie: string, id: string) {
  return req("POST", `/api/receipts/${id}/extract`, { cookie });
}
const jsonRes = (status: number, obj: unknown) =>
  Promise.resolve(new Response(J(obj), { status, headers: { "Content-Type": "application/json" } }));
const CANDIDATE_TEXT = J({ amount: 50000, date: "2026-09-10", merchant: "TOKO M", type: "EXPENSE", category: "Food" });
const okProvider = () => jsonRes(200, { candidates: [{ content: { parts: [{ text: CANDIDATE_TEXT }] } }] });
const errProvider = (status: number) =>
  jsonRes(status, { error: { code: status, message: `simulated provider failure ${status}`, status: "SIMULATED" } });

await waitUp();
const reg = await req("POST", "/api/auth/register", { body: { email: "aidiag@example.com", password: "password123" } });
check("register 201", reg.status === 201, String(reg.status));
const cookie = (reg.setCookie.split(";")[0] ?? "");
await import("node:fs/promises").then((fs) =>
  fs.writeFile("C:\\Users\\DEVELO~1\\AppData\\Local\\Temp\\opencode\\diag-cookie.txt", cookie),
);

// S1 success
{
  const u = await upload(cookie);
  stub = okProvider; providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S1 success 200 + echo", r.status === 200 && (r.body?.extraction as Record<string, unknown>)?.amount === 50000, `${r.status} ${J(r.body)}`);
  const row = await db.receipt.findUnique({ where: { id: u.id } });
  check("S1 NEEDS_REVIEW + extractedAt", row?.status === "NEEDS_REVIEW" && row?.extractedAt !== null, String(row?.status));
  check("S1 provider called once", providerCalls === 1, String(providerCalls));
}
// S2 400
{
  const u = await upload(cookie);
  stub = () => errProvider(400); providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S2 400->502 contract", r.status === 502 && r.body?.error === "AI provider error", `${r.status} ${J(r.body)}`);
  const row = await db.receipt.findUnique({ where: { id: u.id } });
  check("S2 FAILED + extractedAt null", row?.status === "FAILED" && row?.extractedAt === null, String(row?.status));
}
// S3 401
{
  const u = await upload(cookie);
  stub = () => errProvider(401); providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S3 401->502", r.status === 502 && r.body?.error === "AI provider error", `${r.status}`);
}
// S4 404
{
  const u = await upload(cookie);
  stub = () => errProvider(404); providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S4 404->502", r.status === 502 && r.body?.error === "AI provider error", `${r.status}`);
}
// S5 429
{
  const u = await upload(cookie);
  stub = () => errProvider(429); providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S5 429->503 busy", r.status === 503 && r.body?.error === "AI provider busy", `${r.status} ${J(r.body)}`);
}
// S6 500
{
  const u = await upload(cookie);
  stub = () => errProvider(500); providerCalls = 0;
  const r = await extract(cookie, u.id);
  check("S6 500->502", r.status === 502 && r.body?.error === "AI provider error", `${r.status}`);
}
// S7 network throw
{
  const u = await upload(cookie);
  stub = () => { throw new TypeError("fetch failed"); };
  const r = await extract(cookie, u.id);
  check("S7 network->502 unreachable", r.status === 502 && r.body?.error === "AI provider unreachable", `${r.status} ${J(r.body)}`);
}
// S8 timeout
{
  const u = await upload(cookie);
  stub = () => { const e = new Error("simulated timeout"); e.name = "TimeoutError"; throw e; };
  const r = await extract(cookie, u.id);
  check("S8 timeout->504", r.status === 504 && r.body?.error === "AI provider timed out", `${r.status} ${J(r.body)}`);
}
// S9 malformed text
{
  const u = await upload(cookie);
  stub = () => jsonRes(200, { candidates: [{ content: { parts: [{ text: "not json at all {{{" }] } }] });
  const r = await extract(cookie, u.id);
  check("S9 malformed->502", r.status === 502 && r.body?.error === "AI returned malformed response", `${r.status} ${J(r.body)}`);
}
// S10 empty candidates
{
  const u = await upload(cookie);
  stub = () => jsonRes(200, { candidates: [] });
  const r = await extract(cookie, u.id);
  check("S10 empty->502", r.status === 502 && r.body?.error === "AI provider returned no result", `${r.status} ${J(r.body)}`);
}
// S12 invalid schema (valid JSON, wrong shape)
{
  const u = await upload(cookie);
  stub = () => jsonRes(200, { candidates: [{ content: { parts: [{ text: "[1,2,3]" }] } }] });
  const r = await extract(cookie, u.id);
  check("S12 invalid->502", r.status === 502 && r.body?.error === "AI returned malformed response", `${r.status} ${J(r.body)}`);
}
// S11 unexpected DB error: delete row mid-flight -> update throws -> 500 INTERNAL_ERROR
{
  const u = await upload(cookie);
  stub = async () => {
    await db.receipt.delete({ where: { id: u.id } }).catch(() => {});
    return (await okProvider()) as Response;
  };
  const r = await extract(cookie, u.id);
  check("S11 db-race->500 extraction failed", r.status === 500 && r.body?.error === "extraction failed", `${r.status} ${J(r.body)}`);
}

// Regression: no Transaction auto-created by any failure/success above
{
  const n = await db.transaction.count({ where: { user: { email: "aidiag@example.com" } } });
  check("regression: zero transactions", n === 0, String(n));
}

console.log(`T: PASS=${pass}/${total}`);

// Cleanup test data + own upload files, then exit (server loop would hang).
const files = await db.receipt.findMany({ where: { user: { email: "aidiag@example.com" } }, select: { filePath: true } });
await db.user.delete({ where: { email: "aidiag@example.com" } }).catch(() => {});
const { unlink } = await import("node:fs/promises");
const { join, dirname, basename } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const root = join(dirname(fileURLToPath(import.meta.url)), "uploads");
for (const f of files) await unlink(join(root, basename(f.filePath))).catch(() => {});
await db.$disconnect();
process.exit(pass === total ? 0 : 1);
