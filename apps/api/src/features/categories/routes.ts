import { Router } from "express";
import { Prisma } from "@prisma/client";
import { db } from "../../infra/db.js";
import { prismaCause, sendError } from "../../infra/logger.js";
import { requireAuth } from "../../shared/auth.js";
import { toApi, toDb } from "../../shared/enums.js";
import { badRequest, unauthorized } from "../../shared/http.js";
import { createCategorySchema, listCategoriesSchema } from "./schemas.js";

const categoriesRoutes = Router();

categoriesRoutes.get("/", requireAuth, (req, res) => {
  const parsed = listCategoriesSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, req, parsed.error, "list_categories");
  if (!req.user) return unauthorized(res, req);
  const userId = req.user.id;
  db.category
    .findMany({
      where: {
        userId,
        ...(parsed.data.type ? { type: toDb(parsed.data.type) } : {}),
      },
      orderBy: { name: "asc" },
    })
    .then((rows) =>
      res.json(
        rows.map((c) => ({ id: c.id, name: c.name, type: toApi(c.type) })),
      ),
    )
    .catch((e) =>
      sendError(res, req, {
        status: 500,
        code: "DATABASE_ERROR",
        message: "failed to list categories",
        operation: "list_categories",
        causeCode: prismaCause(e),
        err: e,
      }),
    );
});

categoriesRoutes.post("/", requireAuth, async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, req, parsed.error, "create_category");
  if (!req.user) return unauthorized(res, req);
  try {
    const c = await db.category.create({
      data: {
        name: parsed.data.name,
        type: toDb(parsed.data.type),
        userId: req.user.id,
      },
    });
    res.status(201).json({ id: c.id, name: c.name, type: toApi(c.type) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return sendError(res, req, {
        status: 409,
        code: "CONFLICT_ERROR",
        message: "category name already exists",
        operation: "create_category",
        causeCode: prismaCause(e),
      });
    sendError(res, req, {
      status: 500,
      code: "DATABASE_ERROR",
      message: "failed to create category",
      operation: "create_category",
      causeCode: prismaCause(e),
      err: e,
    });
  }
});

export { categoriesRoutes };
