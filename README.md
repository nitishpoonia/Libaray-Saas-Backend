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
| Billing (owner) | `GET /billing`, `POST /billing/orders`, `POST /billing/verify`, `POST /billing/webhook` (Razorpay) |

### Roles

| | Owner | Manager | Staff |
|---|:-:|:-:|:-:|
| Students, renewals, collect fees, seat availability | ✓ | ✓ | ✓ |
| Payments list and receipts | All | All | Only ones they recorded |
| Void payments, expenses, finance on dashboard, seats, branch settings | ✓ | ✓ | |
| Create branches, manage staff, billing | ✓ | | |

### Membership lifecycle

`ACTIVE` → period ends without renewal → `OVERDUE` (seat held for the grace period, 7 days by default) → `CANCELLED` on day 7, seat released. A renewal creates a new period linked to the old one, which becomes `COMPLETED`. Renewing an overdue membership continues from the day after the old period ended, so the overdue days (when the seat was held) are paid for. Fees are tracked per period; a period's `paymentStatus` is `PAID` or `PENDING`.

### Billing

Prepaid plans for the whole owner account, priced by branch count: ₹999/month for the first branch plus ₹499 per extra branch (`PLAN_*_PAISE`). Plans are 1, 3 or 12 months; yearly is charged as 10.

1. The app calls `POST /billing/orders` with a plan. The server works out the amount and creates a Razorpay order.
2. The app opens Razorpay Checkout with the returned `orderId` and `keyId`.
3. On success, the app sends the `razorpay_payment_id` and `razorpay_signature` to `POST /billing/verify`. Razorpay's `order.paid` webhook does the same in case the app closes before step 3; whichever arrives second changes nothing.

A new plan starts when the current trial or plan ends. Branches are free during the trial. During a paid period, a new branch needs a `BRANCH_ADDON` order first (the extra-branch price for the days left); `POST /libraries` answers `402 BRANCH_PAYMENT_REQUIRED` with the amount. The daily job reminds owners 7, 3 and 1 days before their trial or plan ends, and marks ended ones `EXPIRED`.

A plan's price is fixed when its order is created. If branches are added before it's paid (a UPI request approved hours later, say), the plan covers branches oldest first up to what was paid for. The rest are read-only: changes answer `402 BRANCH_PAYMENT_REQUIRED` with the add-on price, the dashboard shows `subscription.branchCovered: false`, and `GET /billing` counts them as `unpaidBranches`. Each `BRANCH_ADDON` covers the next one.

Set up in the Razorpay dashboard: API keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) and a webhook to `https://<api>/v1/billing/webhook` for the `order.paid` event (`RAZORPAY_WEBHOOK_SECRET`). The app won't start with keys but no webhook secret. The webhook answers 500 if applying a payment fails, so Razorpay retries it.

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
