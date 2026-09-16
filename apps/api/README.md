# apps/api

Node.js + TypeScript + Express + Prisma + Zod + PostgreSQL.

## Setup

```powershell
cp .env.example .env
npm install
npx prisma generate
```

Requires PostgreSQL running locally and `DATABASE_URL` set in `.env`.
(`prisma migrate` comes later with the domain models.)

## Run (independent of web)

```powershell
npm run dev --workspace api
# or, from this folder:
npm run dev
```

- API: `http://localhost:3001`
- Health: `GET /api/health` → `{ "ok": true }`

## Scripts

- `npm run dev` — Express with tsx watch
- `npm run build` — compile to `dist/`
- `npm run start` — run compiled output
- `npx prisma generate` — regenerate Prisma client
- `npx prisma migrate dev` — run migrations (once models exist)
