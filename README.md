# Personal Financial MVP (v0.1)

Minimal scaffold. No business features yet.

## Structure

- `apps/web` — React + TypeScript + Vite + TanStack Query + Tailwind CSS
- `apps/api` — Node.js + TypeScript + Express + Prisma + Zod + PostgreSQL
- `packages/` — reserved for shared code (empty for MVP)
- `docs/` — notes only, no code

## Run locally

See `apps/web/README.md` and `apps/api/README.md`.

- Web: `npm run dev --workspace apps/web` (reads `apps/web/.env`, defaults to `http://localhost:3001` API)
- API: `npm run dev --workspace apps/api` (reads `apps/api/.env`, requires `DATABASE_URL`)

Each app runs independently. No root dev script on purpose.
