# apps/web

React + TypeScript + Vite + TanStack Query + Tailwind CSS (v4).

## Setup

```powershell
cp .env.example .env
npm install
```

## Run (independent of api)

```powershell
npm run dev --workspace web
# or, from this folder:
npm run dev
```

- Dev server: `http://localhost:5173`
- API base URL comes from `VITE_API_URL` in `.env`.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — typecheck + production build
- `npm run preview` — serve production build locally
