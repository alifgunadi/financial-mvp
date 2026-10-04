import { Router } from "express";
import { Prisma } from "@prisma/client";
import { db } from "../../infra/db.js";
import { env } from "../../infra/env.js";
import { logInfo, prismaCause, sendError } from "../../infra/logger.js";
import {
  createSession,
  hashPassword,
  requireAuth,
  resolveRole,
  revokeSession,
  verifyPassword,
} from "../../shared/auth.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { loginSchema, registerSchema } from "./schemas.js";

const authRoutes = Router();

// Dummy hash so unknown identifiers cost the same bcrypt work as real ones
// (no timing oracle for account existence).
const DUMMY_HASH = "$2b$10$Elt6aKm7F08vGituLc90iumw95Es6Pa50sTWlTFe/Mw9KS7h1cCHK";

authRoutes.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "register_user");
  // NOTE: registerSchema strips unknown keys, so a client-sent "role" is ignored.
  // Username is set here once and never changed afterwards (PATCH /profile
  // strips it, so it cannot be updated through there either).
  try {
    const existingSuperadmin = await db.user.findFirst({
      where: { role: "SUPERADMIN" },
      select: { id: true },
    });
    const role = resolveRole(parsed.data.email, env.SUPERADMIN_EMAIL, existingSuperadmin !== null);
    const user = await db.user.create({
      data: {
        email: parsed.data.email,
        username: parsed.data.username,
        name: parsed.data.name,
        passwordHash: await hashPassword(parsed.data.password),
        role,
      },
    });
    // No session here: registration never authenticates. The user logs in
    // separately, which is the only place a session is created.
    logInfo({ req, operation: "register_user", message: `user registered id=${user.id}` });
    res.status(201).json({
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = e.meta?.target;
      const fields = Array.isArray(target)
        ? target.filter((t): t is string => typeof t === "string")
        : [];
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: fields.includes("username")
          ? "username already taken"
          : "email already registered",
        operation: "register_user",
        causeCode: prismaCause(e),
      });
    }
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to register",
      operation: "register_user",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

authRoutes.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "login_user");
  // One identifier, email or username: a single OR lookup, no branching on
  // shape. Usernames never contain "@" by construction, so the two sides
  // cannot collide with each other.
  const user = await db.user
    .findFirst({
      where: {
        OR: [{ email: parsed.data.identifier }, { username: parsed.data.identifier }],
      },
    })
    .catch(() => null);
  const ok = await verifyPassword(
    parsed.data.password,
    user ? user.passwordHash : DUMMY_HASH,
  ).catch(() => false);
  if (!user || !ok)
    return sendError(res, req, {
      status: 401,
      code: "AUTHENTICATION_ERROR",
      message: "invalid email or password",
      operation: "login_user",
    });
  try {
    const role = user.role as "CLIENT" | "SUPERADMIN";
    const sessionToken = await createSession({
      id: user.id,
      email: user.email,
      username: user.username,
      role,
    });
    logInfo({ req, operation: "login_user", message: `user logged in id=${user.id}` });
    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role,
      sessionToken,
    });
  } catch (e) {
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to log in",
      operation: "login_user",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

authRoutes.post("/logout", async (req, res) => {
  await revokeSession(req);
  res.json({ ok: true });
});

authRoutes.get("/me", requireAuth, (req, res) => {
  if (!req.user) return unauthorized(res, req);
  res.json({
    id: req.user.id,
    email: req.user.email,
    username: req.user.username,
    role: req.user.role,
  });
});

export { authRoutes };
