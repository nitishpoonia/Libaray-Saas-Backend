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
| `npm test` | Run unit and integration tests (needs the test database, see below) |
| `npm run db:migrate` | Create and apply a migration from schema changes (local only) |
| `npm run db:deploy` | Apply committed migrations (production) |

## Tests

Integration tests use a separate database, `library_saas_test` by default (override with `TEST_DATABASE_URL`). Create it once and apply migrations:

```
createdb library_saas_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/library_saas_test npx prisma migrate deploy
npm test
```

## Deploying on Render

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build` |
| Pre-deploy command | `npm run db:deploy` |
| Start command | `npm start` |
| Health check path | `/health` |

Required environment variables are listed in `.env.example`. On Render, set `NODE_ENV=production` and `TRUST_PROXY=1`.

### Daily job (Render Cron Job)

A second Render service of type **Cron Job**, same repo and environment variables:

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build` |
| Command | `node dist/jobs/daily.js` |
| Schedule | `30 3 * * *` (03:30 UTC = 09:00 IST) |

Each run updates membership statuses, texts overdue students (once per period, plus a warning on the last reserved day) and pushes a digest to owners and managers. It's safe to run more than once a day: nothing is sent twice, and failed messages are retried on the next run. Every run is recorded in the `job_runs` table.

If a run is started while another is still going (say, a manual run during the scheduled one), it exits without doing anything. A run stuck as RUNNING for over an hour counts as crashed, and the next run takes over.

Student texts are DLT templates, defined in `src/modules/notifications/templates.ts` in the exact form to register (`{#var#}` placeholders). The SMS/WhatsApp sender gets the template name and the values in order.

Student texts use `STUDENT_NOTICE_CHANNEL` (SMS or WhatsApp). Until a provider is connected (`TEXT_PROVIDER=none`), texts are logged and recorded as `SKIPPED`.

## API (v1)

All routes are under `/v1`. Success responses are `{ data, meta? }`, errors are `{ error: { code, message, details? } }`. Dates are `YYYY-MM-DD` in the branch's timezone; times are 24-hour `HH:MM`; money is rupees.

Auth uses a 15-minute access token (`Authorization: Bearer …`) and a 30-day refresh token that rotates on every refresh.

A refresh token works once. If the app sends the same one twice (for example, two requests hit 401 together and both refresh), only one call succeeds and the others get `SESSION_EXPIRED`. So the app should run one refresh at a time: the first 401 starts it, and other requests wait for that result instead of refreshing on their own.

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all` |
| Me | `GET/PATCH /me`, `POST /me/password`, `POST /me/devices`, `DELETE /me/devices/:token` |
| Branches | `GET/POST /libraries`, `GET/PATCH /libraries/:libraryId` |
| Dashboard | `GET /libraries/:libraryId/dashboard?month=YYYY-MM` |
| Seats | `GET/POST /libraries/:libraryId/seats`, `GET …/seats/availability`, `PATCH/DELETE …/seats/:seatId` |
| Students | `GET/POST …/students`, `GET/PATCH/DELETE …/students/:studentId`, `POST …/students/:studentId/renewals` |
| Payments | `POST …/memberships/:membershipId/payments`, `GET …/payments`, `GET …/payments/:paymentId/receipt`, `POST …/payments/:paymentId/void` |
| Expenses | `GET/POST …/expenses`, `PATCH/DELETE …/expenses/:expenseId` |
| Staff | `GET/POST …/staff`, `PATCH/DELETE …/staff/:staffId` |

### Roles

| | Owner | Manager | Staff |
|---|:-:|:-:|:-:|
| Students, renewals, collect fees, seat availability | ✓ | ✓ | ✓ |
| Void payments, expenses, finance on dashboard, seats, branch settings | ✓ | ✓ | |
| Create branches, manage staff, billing | ✓ | | |

### Membership lifecycle

`ACTIVE` → period ends without renewal → `OVERDUE` (seat held for the grace period, 7 days by default) → `CANCELLED` on day 7, seat released. A renewal creates a new period linked to the old one, which becomes `COMPLETED`. Fees are tracked per period; a period's `paymentStatus` is `PAID` or `PENDING`.

## Code layout

```
src/
  config/       validated environment variables
  lib/          prisma client, logger, errors, dates, money, validation
  middleware/   auth, branch access + roles, subscription, rate limits, errors
  modules/      one folder per feature: routes, schemas, service
    memberships/  slot overlap, lifecycle rules, seat locking
tests/
  unit/         pure logic (slots, rules, config, errors)
  integration/  full HTTP flows against a real Postgres
```

Open issues and the planned architecture are tracked in [`REVIEW.md`](./REVIEW.md).
