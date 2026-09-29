# Library SaaS — Backend

REST API for the Library SaaS app: Express 5, TypeScript, Prisma 7, PostgreSQL.

## Run locally

1. Install Node 22+ and PostgreSQL.
2. `cp .env.example .env` and fill in `DATABASE_URL` and `JWT_SECRET`.
3. `npm install` (also generates the Prisma client).
4. `npm run db:migrate` to create the tables.
5. `npm run dev` starts the API with reload on save.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server with reload (tsx watch) |
| `npm run build` | Generate Prisma client and bundle to `dist/` |
| `npm start` | Run the built server (production) |
| `npm run typecheck` | TypeScript check, no output |
| `npm test` | Run tests once |
| `npm run db:migrate` | Create and apply a migration from schema changes (local only) |
| `npm run db:deploy` | Apply committed migrations (production) |

## Deploying on Render

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build` |
| Pre-deploy command | `npm run db:deploy` |
| Start command | `npm start` |
| Health check path | `/health` |

Required environment variables are listed in `.env.example`. On Render, set `NODE_ENV=production` and `TRUST_PROXY=1`.

## Code layout

```
src/
  config/       validated environment variables
  lib/          prisma client, logger, errors, firebase
  middleware/   auth, rate limits, error handler
  modules/      one folder per feature (routes + controller)
  jobs/         scheduled work
tests/
```

Open issues and the planned architecture are tracked in [`REVIEW.md`](./REVIEW.md).
