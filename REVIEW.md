# Backend Review — Library SaaS

A code and architecture review done before production work starts. This file only lists problems and the direction of each fix; no code changes have been made yet. Tick an item when it's fixed.

Line numbers refer to commit `main` as of 29 Sep 2026.

## Priority scale

| Priority | Meaning |
|---|---|
| **P0** | Security hole or data corruption. Must be fixed before real users. |
| **P1** | Wrong results users will see (wrong numbers, double bookings, missing students). |
| **P2** | Will hurt maintainability, operations or scale. Fix before growth. |
| **P3** | Cleanup and consistency. |

## Product decisions (confirmed with owner)

These answers shape several fixes below.

- **Trial length:** 14 days. The code currently gives 14 hours.
- **"Overdue" means fees are unpaid.** An overdue membership is *paused*. The seat stays reserved for 7 days. On day 6, the student and the owner get a message saying the membership will be cancelled the next day. On day 7 the membership is cancelled and the seat becomes free for the next student.
- **Multiple branches:** one owner can have several libraries (branches) in the future.
- **`delayMiddleware`:** only meant to simulate latency locally, not for production.

---

## 1. Security

- [x] **S1 · P0 · Any owner can read and change any other library's data.**
  Where: every route that takes `libraryId`, `library_id`, `studentId` or `membership_id`. Examples: `student/controller.ts:95` and `:306` (library id taken from the request body), `:662` (`deleteStudent` finds the student by id only), `seats/controller.ts:18`, `dashboard/controller.ts:12`, `expenses/controller.ts:18`.
  Problem: the token proves *who* the owner is, but no route checks that the requested library or student *belongs* to that owner. A logged-in owner can change the ids in a request and read other libraries' students (names, phone numbers, payments), deactivate their students, add payments or expenses to them, and read their revenue.
  Why `subscriptionCheck` doesn't protect this: it checks the caller's own library, not the one in the request.
  Fix direction: one ownership middleware that loads the library from the request and confirms `library.owner_id === token user id`, then attaches it to the request. Every query then filters by that library id, including lookups by student or membership id. Because branches are coming, the middleware should check the `libraryId` route param against the owner, not assume one library per owner.
  **Status:** fixed in PR `feat/domain-rewrite`: `libraryAccess` middleware resolves the branch and role; every query filters by it. Tested.

- [x] **S2 · P0 · `listExpiringSoonStudents` can return every library's students.**
  Where: `student/controller.ts:983–1007`.
  Problem: if the owner has no library, `libraryId?.id` is `undefined`. Prisma treats `undefined` in a `where` as "no filter", so the query returns expiring memberships across *all* libraries, including student data.
  Fix direction: return 404 when no library is found (as the overdue endpoint already does), and resolve the library through the S1 middleware.
  **Status:** fixed in PR `feat/domain-rewrite`: the endpoint is gone; lists go through the branch check.

- [x] **S3 · P0 · Any user can trigger notifications to all owners.**
  Where: `notification/routes.ts:12` (`POST /notification/test-notification`).
  Problem: any logged-in owner can call this, and it runs the global job that notifies every owner in the system.
  Fix direction: remove it from production, or restrict it to an admin role.
  **Status:** fixed in PR `feat/domain-rewrite`: test endpoint removed.

- [x] **S4 · P0 · Database URL printed to logs.**
  Where: `utils/prisma.ts:9`.
  Problem: the full connection string, including the password, is written to Render's logs on every boot.
  Fix direction: remove the log. If anyone else could have seen those logs, rotate the database password.
  **Status:** fixed in PR `chore/foundation`. Still rotate the DB password if old logs were visible to anyone.

- [x] **S5 · P0 · Login logs the plain-text password.**
  Where: `auth/loginController.ts:20` (`console.log("boyd", body)`).
  Problem: the request body with the password is written to logs. `library/controller.ts:18` and `student/controller.ts:78` log full bodies too.
  Fix direction: remove body logging. Use a logger that redacts sensitive fields (password, token, phone).
  **Status:** fixed in PR `chore/foundation`: body logs removed, pino logger redacts passwords, tokens and auth headers.

- [x] **S6 · P1 · Rate limiting breaks behind Render's proxy.**
  Where: `app.ts` (no `trust proxy` setting), `middleware/rateLimiters.ts`.
  Problem: on Render, every request reaches Express from the proxy. Without `trust proxy`, the limiter can see the same IP for all users, so 5 login attempts in 10 minutes could be shared by *everyone*. `generalRateLimiter` is defined but never used.
  Fix direction: set `trust proxy` to match Render's proxy hop count, and apply the general limiter to authenticated routes.
  **Status:** fixed in PR `chore/foundation`: `TRUST_PROXY` env (set 1 on Render), general limiter on all routes.

- [x] **S7 · P1 · Tokens can't be revoked.**
  Where: `auth/controller.ts:83`, `auth/loginController.ts:55`, `auth/logoutController.ts`.
  Problem: tokens live 7 days, logout does nothing on the server, and changing the password doesn't invalidate old tokens. A stolen phone stays logged in for a week even after a password change.
  Fix direction: short-lived access token plus refresh token, or a token version stored on the owner and bumped on password change and logout.
  **Status:** fixed in PR `feat/domain-rewrite`: 15-minute access tokens + rotating refresh tokens stored as hashes; logout and password change revoke sessions.

- [x] **S8 · P2 · Login leaks whether an account exists.**
  Where: `auth/loginController.ts:42` and `:47`.
  Problem: "Invalid email/phone or password" and "Invalid email or password" are two different messages, so an attacker can tell which case happened. Both also return 400 instead of 401.
  Fix direction: one identical message and status for both cases.
  **Status:** fixed in PR `feat/domain-rewrite`: one message and status, constant-time comparison.

- [x] **S9 · P2 · Weak password rules on change.**
  Where: `userProfile/controller.ts:117–129`.
  Problem: signup requires 8+ characters, but change-password accepts any length.
  Fix direction: one shared password rule used by both.
  **Status:** fixed in PR `feat/domain-rewrite`: one shared password rule (8-72 chars).

- [x] **S10 · P2 · `delayMiddleware` runs on every request, with no environment check.**
  Where: `app.ts:14`.
  Problem: it's meant for local testing only, but nothing in the code stops it from running in production. Every API call would be 2 seconds slower.
  Fix direction: enable it only when an explicit local-only environment flag is set.
  **Status:** fixed in PR `chore/foundation`: replaced by `SIMULATE_LATENCY_MS`, which config refuses in production.

---

## 2. Business logic bugs

- [x] **B1 · P1 · Seat overlap check is wrong for slots that cross midnight, so double bookings happen.**
  Where: `utils/timeUtils.ts:33–55`.
  Problem: the function reports *no overlap* in all four of these real overlaps. I tested each case against the current function:
  | Existing slot | New slot | Real overlap | Function says |
  |---|---|---|---|
  | 22:00–02:00 | 10:00–23:00 | 22:00–23:00 | no overlap |
  | 22:00–02:00 | 01:00–03:00 | 01:00–02:00 | no overlap |
  | 21:00–23:00 | 22:00–02:00 | 22:00–23:00 | no overlap |
  | 09:00–12:00 | 22:00–10:00 | 09:00–10:00 | no overlap |
  The midnight branch uses "starts after existing start OR ends before existing end", which isn't an overlap test. The new slot crossing midnight isn't handled at all.
  Fix direction: split any slot that crosses midnight into two ranges (`start → 24:00` and `00:00 → end`) and check every pair of ranges. Cover this with unit tests, including the four cases above.
  **Status:** fixed in PR `feat/domain-rewrite`: slots split into ranges; all four cases covered by tests.

- [x] **B2 · P1 · Two bookings at the same moment can take the same seat.**
  Where: `student/controller.ts:139–189` (availability check) and `:210` (create), `renewMembership` `:534–619`.
  Problem: the check and the insert are separate steps with no lock. Two requests arriving together both see the seat as free and both book it. Nothing in the database stops this either.
  Fix direction: run check plus insert in one transaction that locks the seat row first, so the second request waits and then sees the first booking.
  **Status:** fixed in PR `feat/domain-rewrite`: seat row locked with SELECT … FOR UPDATE; 5 simultaneous bookings → exactly one succeeds (tested).

- [x] **B3 · P1 · Fully paid students disappear from the student list.**
  Where: `student/controller.ts:856–859` and `:875–882`.
  Problem: the list only loads memberships with status `"active"`. Paid-in-full memberships have status `"paid"`, so those students look inactive and get filtered out of the default list.
  Fix direction: see D1. Payment state shouldn't be stored in the same field as membership state.
  **Status:** fixed in PR `feat/domain-rewrite`: payment state is separate from membership status.

- [x] **B4 · P1 · Student list pagination breaks.**
  Where: `student/controller.ts:850–882`.
  Problem: the active/inactive filter is applied in JavaScript *after* the database already returned one page. A page of 20 can show 3 students while `total` counts all of them, so infinite scroll stops early or shows short pages.
  Fix direction: move the status filter into the database query so `total` and the page use the same filter.
  **Status:** fixed in PR `feat/domain-rewrite`: all list filters run in the database.

- [x] **B5 · P1 · Available-seats screen and add-student disagree.**
  Where: `seats/controller.ts:75` checks `status: "active"`; `student/controller.ts:147` checks `["active", "paid"]`.
  Problem: a seat held by a fully paid student shows as available in the app, and then booking it fails with "seat not available".
  Fix direction: one shared "is this seat taken" function used by both endpoints.
  **Status:** fixed in PR `feat/domain-rewrite`: one `findConflicts` used by availability and booking.

- [x] **B6 · P1 · Deleting a fully paid student keeps their seat booked.**
  Where: `student/controller.ts:681–690`.
  Problem: only memberships with status `"active"` are expired. A `"paid"` membership stays and keeps blocking the seat until its end date.
  Fix direction: end every current membership of the student, whatever its payment state.
  **Status:** fixed in PR `feat/domain-rewrite`.

- [x] **B7 · P1 · Memberships never expire on their own.**
  Where: nothing in the codebase sets status to expired except `deleteStudent`.
  Problem: once `end_date` passes, the membership stays `"active"`. Dashboard counts, occupied seats and "active students" include people whose time ran out.
  Fix direction: the lifecycle job in A3 moves memberships through their states every day.
  **Status:** fixed in PR `feat/domain-rewrite`: `syncLifecycle` moves periods to their status for today; reads call it, and the daily job (next PR) sends the notices.

- [x] **B8 · P1 · The overdue feature doesn't match the product rule.**
  Where: `student/controller.ts:953–964`, `dashboard/controller.ts:25–32`.
  Problem: "overdue" is currently "end date is in the past", counted across *every* membership ever, including deleted students. The confirmed rule is fees unpaid, then a 7-day pause with the seat reserved, a day-6 warning to student and owner, and cancellation plus seat release on day 7. None of those steps exist: there's no paused state, no grace-period date, no day-6 message and no automatic release. Students also have no email field to send the warning to.
  Fix direction: A2 (membership state machine) and A3 (scheduled jobs).
  **Status:** fixed across `feat/domain-rewrite` (statuses, seat held) and PR `feat/daily-job-notifications` (overdue text, day-6 warning to student, digest to owner).

- [x] **B9 · P1 · Dashboard numbers are wrong.**
  Where: `dashboard/controller.ts`.
  Problem: "occupied seats" is the count of `"active"` memberships, which excludes paid ones (B3) and includes ones past their end date (B7). "Inactive students" subtracts memberships from students, which are different units. "Available" can go negative. Revenue and expenses are lifetime totals with no month filter.
  Fix direction: compute occupancy from current memberships by seat, and give finance a date range (this month by default).
  **Status:** fixed in PR `feat/domain-rewrite`: occupancy by seats held today, finance per month, staff don't see finance.

- [x] **B10 · P1 · Trial is 14 hours, not 14 days.**
  Where: `library/controller.ts:31`.
  Fix direction: 14 days. Also see A1: with branches, the trial probably belongs to the owner account, not to each library.
  **Status:** fixed in PR `feat/domain-rewrite`: 14-day trial on the owner's organization (`TRIAL_DAYS`).

- [x] **B11 · P1 · Expiry notification fires only once per membership, ever.**
  Where: `notification/notificationController.ts:58–62`.
  Problem: the job skips any membership that already has an `expiry_within_7_days` log. Renewal extends the *same* membership row, so after the first renewal the owner is never warned again for that student.
  Fix direction: key the log on the membership *period* (see D2) or on the end date being warned about.
  **Status:** fixed in PR `feat/daily-job-notifications`: notices are keyed by membership period, type, channel, recipient and date.

- [x] **B12 · P2 · "Expected renewal revenue" in notifications is inflated.**
  Where: `notification/notificationController.ts:99`.
  Problem: it sums `total_fee`, which keeps growing with every renewal (`student/controller.ts:579`). A student renewed 5 times counts 6 fees.
  Fix direction: use the fee of the latest period.
  **Status:** fixed in PR `feat/daily-job-notifications`: each period has its own fee, so renewal amounts are real.

- [x] **B13 · P2 · Receipt numbers can collide.**
  Where: `utils/receiptUtils.ts`.
  Problem: the number is "count of today's payments + 1", across *all* libraries. Two payments at the same moment get the same number, the unique constraint throws, and the owner sees a 500. It also means one library's receipts skip numbers because of other libraries.
  Fix direction: a per-library counter incremented atomically inside the payment transaction.
  **Status:** fixed in PR `feat/domain-rewrite`: per-branch counter incremented inside the payment transaction; tested concurrently.

- [x] **B14 · P2 · Dates use the server's timezone, not India's.**
  Where: every `dayjs()` call for "today", "start of day", "+N days". For example `student/controller.ts:951` and `:992`, `dashboard/controller.ts:24`.
  Problem: Render runs in UTC. "Today" starts at 05:30 IST, so from midnight to 05:30 India time, overdue and expiring lists are off by a day. The cron job does use `Asia/Kolkata`, but nothing else does.
  Fix direction: store a timezone on each library (default `Asia/Kolkata`) and compute day boundaries in it.
  **Status:** fixed in PR `feat/domain-rewrite`: each branch has a timezone (default Asia/Kolkata) used for every "today".

- [x] **B15 · P2 · Memberships start at the current clock time.**
  Where: `student/controller.ts:136–137`.
  Problem: a student added at 18:00 gets `start_date` 18:00 and `end_date` 18:00 N days later. Whether they count as expired on the last day depends on the time of the check.
  Fix direction: store membership periods as calendar dates in the library's timezone.
  **Status:** fixed in PR `feat/domain-rewrite`: periods are DATE columns in branch time.

- [x] **B16 · P2 · Invalid input returns 500 instead of 400.**
  Where: `helpers/basicHelper.ts:16` (`validateIdentifier` throws), used by `auth/controller.ts:29` and `auth/loginController.ts:29`. `parseTime` (`basicHelper.ts:25`) never returns null, so the "Invalid time format" checks in `seats/controller.ts:43` and `student/controller.ts:115` can never trigger. `"ab:cd"` becomes `NaN` and flows into the database.
  Also: signup looks the user up before checking the identifier format (`auth/controller.ts:29–42`).
  Fix direction: a validation layer at the edge of every route (see C2).
  **Status:** fixed in PR `feat/domain-rewrite`: zod validation on every route.

- [x] **B17 · P2 · Creating a second library crashes.**
  Where: `library/controller.ts:25`.
  Problem: `library_owner_id` is unique, so a second create hits a unique-constraint error and returns 500. When branches arrive, this constraint has to go anyway (A1).
  **Status:** fixed in PR `feat/domain-rewrite`: owners can create several branches.

- [x] **B18 · P2 · Profile update can fail or save bad data.**
  Where: `userProfile/controller.ts:61–93`.
  Problem: changing email or phone to one that's already taken returns 500 (unhandled unique error). Signup stores phones as `+91XXXXXXXXXX`, but update validates with `isPhone`, which expects the `+91` already included, so the two flows accept different formats. Email and phone change without verification.
  **Status:** fixed in PR `feat/domain-rewrite`: phone normalised to +91…; taken email/phone → 409.

- [x] **B19 · P2 · Reducing seats is blocked by old history.**
  Where: `library/controller.ts:199–201`.
  Problem: the "occupied" check counts *all* memberships ever, including expired ones, so a seat that was used once can never be removed. The error message says "active memberships", which isn't what the code checks. Seat changes and the library update also aren't in one transaction.
  **Status:** fixed in PR `feat/domain-rewrite`: seats are archived; only current/future bookings block removal.

- [x] **B20 · P3 · Seat numbers are strings sorted as numbers.**
  Where: `library/controller.ts:193`.
  Problem: if an owner ever names seats like "A1", sorting and comparisons break.
  **Status:** fixed in PR `feat/domain-rewrite`: free-text labels with a separate display position.

---

## 3. Data model (`prisma/schema.prisma`)

- [x] **D1 · P1 · Membership `status` mixes two different things.**
  Values in use: `active`, `paid`, `expired`. "Paid" is a payment fact, while active and expired describe the membership's lifecycle. A membership can be active *and* fully paid, which is why B3, B5 and B6 happen.
  Fix direction: a lifecycle status (enum: `active`, `paused`, `cancelled`, `completed`) and a separate payment state derived from `total_fee - paid_amount`.
  **Status:** fixed in PR `feat/domain-rewrite`.

- [x] **D2 · P1 · Renewal overwrites history.**
  Where: `renewMembership` updates the same row (`student/controller.ts:600–614`).
  Problem: after a renewal, the old period's dates, seat and timing are lost, and fees keep accumulating on one row. You can't answer "what did this student pay for March" or "who sat on seat 12 last month".
  Fix direction: each renewal creates a new *membership period* row linked to the student, and payments link to the period they paid for.
  **Status:** fixed in PR `feat/domain-rewrite`: each renewal is a new row linked by `previousId`.

- [x] **D3 · P1 · No support for the pause / grace period rule.**
  Missing: a `paused` state, a date the pause started, a cancel-by date, and a record that the day-6 warning was sent.
  **Status:** fixed in PR `feat/domain-rewrite`: OVERDUE status + `graceEndsOn`.

- [x] **D4 · P1 · Students have no email.**
  The day-6 warning goes to the student, but `Students` only has `phone`. See open question Q2.
  **Status:** resolved: notices go by SMS/WhatsApp to the student's phone (owner's decision), so no email field.

- [x] **D5 · P2 · Status and category fields are free strings.**
  `Library.status`, `Memberships.status`, `Payments.payment_mode`, `Expenses.category`, `NotificationLog.notification_type`. A typo like `"Active"` silently creates a new state.
  Fix direction: Prisma enums.
  **Status:** fixed in PR `feat/domain-rewrite`: enums for statuses, roles, payment modes, notification types. Expense category stays free text on purpose.

- [x] **D6 · P2 · Owner ↔ library is one-to-one.**
  `library_owner_id @unique` blocks branches. See A1.
  **Status:** fixed in PR `feat/domain-rewrite`: Organization → many Libraries.

- [x] **D7 · P2 · Subscription lives on `Library`.**
  With branches, it's unclear whether an owner pays per branch or per account. `plan_type` is never used, and nothing records how or when an owner paid you. See Q3.
  **Status:** fixed in PR `feat/domain-rewrite`: subscription on Organization with `billedBranches`; Razorpay fields ready.

- [x] **D8 · P2 · The push token column has the wrong name.**
  `expo_push_token` holds a Firebase (FCM) token, and `expo-server-sdk` is installed but unused. One token per owner also means only the last device that logged in gets notifications.
  Fix direction: a `device_tokens` table (owner, token, platform, last seen).
  **Status:** fixed in PR `feat/domain-rewrite`: `device_tokens` table, one row per phone.

- [x] **D9 · P2 · Missing indexes and constraints.**
  No index on `Students(library_id)`, `Memberships(student_id)`, `Memberships(library_id, end_date)` (used by overdue and expiring queries), or `Payments(library_id, payment_date)`. Student phone isn't validated or unique per library, so duplicates are easy.
  **Status:** fixed in PR `feat/domain-rewrite`: indexes for every list and availability query; CHECK constraints for money and dates.

- [x] **D10 · P3 · Naming is mixed.**
  Plural model names (`Students`, `Seats`) next to singular ones (`Library`), and `isActive` next to `snake_case` columns. Pick one convention before the schema grows.
  **Status:** fixed in PR `feat/domain-rewrite`: singular models, camelCase fields, snake_case columns.

---

## 4. API design

- [x] **API1 · P2 · Routes are verb-style and inconsistent.**
  Examples: `/libraries/student/add-student`, `/libraries/:id/list-all-expenses`, `/seats/:libraryId/available-seats` (a `POST` that only reads), `/libraries/update-library-details` (no id, so it can't work with branches), `/student/delete-student` with the id in a `DELETE` body.
  Fix direction: resource-style routes nested under the branch, like `/libraries/:libraryId/students`, `/libraries/:libraryId/students/:studentId/memberships`, and `GET /libraries/:libraryId/seats/availability?…`. Branch-scoped routes also make the S1 check automatic.
  **Status:** fixed in PR `feat/domain-rewrite`: resource routes nested under the branch.

- [x] **API2 · P2 · Response shapes differ between endpoints.**
  Some return `{ error }`, some `{ message }`, some `{ success, … }`, some `{ status: true, … }`, and field names switch between `snake_case` and `camelCase` (`receipt.student_name` vs `student.studentId`). The app has to special-case each one.
  Fix direction: one envelope for success and one for errors (with a machine-readable error code), and one casing.
  **Status:** fixed in PR `feat/domain-rewrite`: `{ data, meta }` / `{ error: { code, message } }`, camelCase everywhere.

- [x] **API3 · P3 · No API versioning.**
  Mobile apps in the store keep running old versions. Without a `/v1` prefix, any breaking change breaks users who haven't updated.
  **Status:** fixed in PR `feat/domain-rewrite`: everything under `/v1`.

- [x] **API4 · P3 · Missing endpoints the app will need.**
  Edit or delete an expense, list payments, cancel a payment entered by mistake, and a health check endpoint for Render.
  **Status:** fixed in PR `feat/domain-rewrite`: expense edit/delete, payment list, void, receipt, health check.

---

## 5. Code structure and practices

Current layout:

```
src/
  modules/<feature>/controller.ts + routes.ts
  middleware/  helpers/  utils/  config/  jobs/
```

Grouping by feature module is the right starting point. The problems are inside the modules.

- [x] **C1 · P2 · Controllers do everything.**
  `student/controller.ts` is 1,128 lines of HTTP parsing, validation, business rules, database queries and response formatting mixed together. The seat availability logic is copy-pasted in three places (`seats/controller.ts`, `createStudent`, `renewMembership`), and they've already drifted apart (B5).
  Fix direction: split each module into `routes` (URL → handler), `controller` (HTTP in/out only), `service` (business rules, transactions) and `schemas` (input validation). Put shared domain logic like seat availability, membership state and receipt numbers in one service each.
  **Status:** fixed in PR `feat/domain-rewrite`: routes + schemas + services; shared domain logic in `modules/memberships`.

- [x] **C2 · P2 · No validation library.**
  Validation is hand-written `if` chains, which are inconsistent and miss types (`seat_number` arrives as string or number, `booked_for` isn't checked for negatives or decimals). `zod` or similar at the route edge gives typed, validated input and consistent 400 errors.
  **Status:** fixed in PR `feat/domain-rewrite`.

- [x] **C3 · P2 · No central error handling.**
  Every handler has its own try/catch that returns a 500 with a different message. Known errors (not found, conflict, unique violation) should become typed errors turned into responses in one error middleware.
  **Status:** fixed in PR `chore/foundation`: central error handler with one error shape; controllers move to it in the modules rewrite.

- [x] **C4 · P2 · Type safety is switched off where it matters.**
  `(req as any).user` appears in every controller, the `where` objects are `any`, and the JWT payload is untyped. Extend Express's `Request` type once with `user` and `library`.
  **Status:** fixed in PR `feat/domain-rewrite`.

- [x] **C5 · P2 · Config and environment handling is scattered.**
  `dotenv.config()` is called in 8 files. `process.env.JWT_SECRET!` assumes the value exists, so a missing secret only fails when the first user logs in.
  Fix direction: one config module that reads and validates all environment variables at startup and refuses to boot if one is missing.
  **Status:** fixed in PR `chore/foundation`: `src/config/env.ts` validates everything at boot.

- [x] **C6 · P3 · Mixed module styles.**
  `config/firebase.js` is JavaScript in a TypeScript project. Imports mix `./x.js` and `./x` in an ESM package, which works under `tsx` but will break with a real `tsc` build.
  **Status:** fixed in PR `chore/foundation`: Firebase moved to TypeScript, imports normalised, bundled with tsup.

- [x] **C7 · P3 · Dead and leftover code.**
  Unused imports (`error`, `log` from `console` in `library/controller.ts:4`, `expenses/controller.ts:4`), the commented-out trial block in `auth/controller.ts:64–70`, `console.log("*****")` in the dashboard, an empty slot in `Promise.all` at `expenses/controller.ts:124`, unused `ts-node`, `expo-server-sdk` and `generalRateLimiter`.
  **Status:** fixed in PR `chore/foundation`.

- [x] **C8 · P2 · No tests.**
  The most bug-prone logic (slot overlap, membership state transitions, fee math, receipt numbers) is pure logic and easy to unit test. B1 would have been caught by a single test.
  **Status:** fixed in PR `feat/domain-rewrite`: 55 unit + integration tests.

---

## 6. Operations and deployment

- [x] **O1 · P0 · Database migrations aren't in git.**
  Where: `.gitignore:11` ignores `prisma/migrations`.
  Problem: `migrate:prod` runs `prisma migrate deploy`, which needs the migration files from the repo. Without them, production schema changes are applied by hand or with `db push`, with no history and no safe way to change a column without data loss.
  Fix direction: commit the migrations folder, and apply migrations in production only through `migrate deploy`.
  **Status:** fixed in PR `feat/domain-rewrite`: baseline migration committed.

- [x] **O2 · P1 · Lock files aren't in git.**
  Where: `.gitignore:42–44`.
  Problem: every deploy can install different dependency versions than you tested with.
  **Status:** fixed in PR `chore/foundation`: `package-lock.json` committed.

- [x] **O3 · P1 · Production runs in watch mode with no build step.**
  Where: `package.json` `start` is `tsx watch src/server.ts`.
  Problem: watch mode is for development. There's no `build`, no type check before deploy, and `prisma generate` isn't in any script.
  Fix direction: separate `dev`, `build` (typecheck plus compile), `start` (run compiled output) and a `postinstall` or build step for `prisma generate`.
  **Status:** fixed in PR `chore/foundation`: `dev`, `build` (prisma generate + tsup), `start` (node dist). See README for Render settings.

- [x] **O4 · P1 · The scheduled job lives inside the web server.**
  Where: `server.ts:10`, `jobs/membershipExpiry.ts`.
  Problem: if the Render instance is asleep at 09:00, the job doesn't run. If you ever run 2 instances, it runs twice. There's no record of whether a day's run finished.
  Fix direction: A3.
  **Status:** fixed in PR `feat/daily-job-notifications`: `dist/jobs/daily.js` runs as a Render Cron Job; runs are recorded in `job_runs`.

- [ ] **O5 · P2 · Logging is `console.log` only.**
  No log levels, no request id, no error tracking. Debugging a user complaint means scrolling raw logs.
  Fix direction: a structured logger with redaction (S5), a request-id middleware, and an error tracker.
  **Status:** partly fixed in PR `chore/foundation`: structured logger with redaction and request ids. Error tracker still to add.

- [x] **O6 · P2 · No CI.**
  Nothing runs lint, typecheck or tests on push.
  **Status:** fixed in PR `chore/foundation`: GitHub Actions runs typecheck, tests and build.

- [ ] **O7 · P2 · Backups and data retention are undefined.**
  Student phone numbers and payment records are personal data. There's no stated backup policy, and no flow to export or delete an owner's data when they leave. India's Digital Personal Data Protection Act applies to this kind of data, so check what it requires.

---

## 7. System architecture review

### What the system is

A multi-tenant SaaS for self-study library (reading room) owners in India. Owners rent seats to students for time slots over a number of days, collect fees (often in parts), issue receipts, track expenses, and get reminders about renewals. Owners pay the platform a subscription after a trial.

### Current architecture

```
React Native app ──HTTPS──> Express monolith (Render) ──> PostgreSQL (Prisma)
                                   │
                                   ├── node-cron inside the web process (09:00 IST)
                                   └── Firebase Admin ──> FCM push to owner's phone
```

For the expected load this shape is fine. A library has roughly 50–300 seats. Even 1,000 libraries means a few hundred thousand student rows and very low request rates, which a single Postgres instance and one API server handle easily. **Scale isn't the risk here. Tenancy, correctness of time and money, and reliable background work are.**

### A1 · Tenancy model for branches · P1

- [x] Target hierarchy: **Owner account → Libraries (branches) → Seats, Students, Membership periods, Payments, Expenses.**
- [x] Every tenant-scoped table keeps `library_id`, and every request resolves the branch through the ownership check (S1). That one check is the tenant boundary for the whole system.
- [x] Decide where the subscription and trial live, per owner or per branch (Q3).
- [x] Plan for staff logins (a receptionist at a branch) now, even if you build them later (Q4). That means an owner↔library membership table with a role, instead of a single `library_owner_id` column.

### A2 · Membership state machine · P1

- [x] Replace the free `status` string with explicit states and allowed transitions:

```
             payment covers the period
   ┌──────────────────────────────────────────┐
   ▼                                          │
ACTIVE ──period ends, not renewed──> OVERDUE (seat reserved) ──day 7──> CANCELLED (seat released)
   │                              │
   │                              └── day 6: warning to student + owner
   └── renewed ──> COMPLETED (new period continues)
```

- [x] Every transition happens in one place (a membership service) and is recorded with a timestamp, so "why was this seat freed?" always has an answer.
- [x] Payment state (fully paid / pending amount) is derived from the period's fee and its payments, never stored as a membership status.
- [x] Seat availability counts only ACTIVE and OVERDUE memberships, because an overdue seat is still reserved.

### A3 · Scheduled jobs · P1

- [x] Move daily work out of the web process into a separate scheduled job (a Render cron job or worker) that runs the same code.
- [x] Daily job steps, each safe to run twice (idempotent):
  1. ACTIVE → PAUSED when fees are due and unpaid.
  2. Send the day-6 warning (to student and owner) for PAUSED memberships.
  3. PAUSED → CANCELLED on day 7, releasing the seat.
  4. Expiry reminders to owners.
- [x] Record each run (date, step, counts, errors) so a missed or failed day is visible and can be re-run.
- [x] Every "already notified?" check is keyed by membership period plus notification type plus the date it refers to, not by membership alone (B11).

### A4 · Messaging · P1

- [x] One notification service with channels behind it: push to owners (FCM, already there), plus a channel that reaches students for the day-6 warning (email, SMS or WhatsApp, see Q2).
- [x] Sending is retried on failure and logged per recipient. The current loop marks nothing when FCM fails and never retries.

### A5 · Time and money rules · P1

- [x] Every "today" and every period boundary is computed in the library's timezone (B14, B15).
- [x] All money stays `Decimal` end to end (already mostly true). Receipt numbers come from a per-library atomic counter (B13).
- [x] Booking and payment writes run in transactions that lock the seat or membership they change (B2).

### A6 · Target backend layout · P2

```
src/
  config/          validated env, constants
  lib/             prisma client, logger, errors, http helpers
  middleware/      auth, loadLibrary (ownership), validate, errorHandler, rateLimit
  modules/
    auth/          routes, controller, service, schemas
    libraries/
    seats/
    students/
    memberships/   state machine, renewal, availability
    payments/      receipts, counters
    expenses/
    notifications/ channels, templates, logs
    subscriptions/
  jobs/            daily lifecycle job (entry point used by the scheduler)
  app.ts           express setup only
  server.ts        start HTTP server only
tests/
```

The rule is that controllers never touch Prisma directly, and services never touch `req` or `res`.

### What I'd revisit as it grows

- A read replica or cached aggregates for dashboards, only if dashboard queries become slow. Not needed now.
- A queue (for example BullMQ on Redis) once messaging volume or retries outgrow a daily job.
- Owner-facing audit log (who changed what) once staff logins exist.

---

## 8. Open questions

- [x] **Q1.** What exactly makes a membership "fees due"? The period ending without renewal, a partial payment still pending after some number of days, or both? This decides when ACTIVE → PAUSED fires.
  **Answer:** a period that ends without renewal becomes OVERDUE, whether or not its fees were paid. Fees are tracked separately: a period with money left is `FEES_PENDING`, and an overdue student with dues shows both flags with the amount.
- [x] **Q2.** Students only have a phone number. Should the day-6 warning go by email (add an email field), SMS, or WhatsApp? In India, SMS and WhatsApp reach students more reliably than email.
  **Answer:** SMS or WhatsApp to the student's phone.
- [x] **Q3.** With branches, does the owner pay per branch or one subscription for the whole account? How will owners pay you: manually, or through a payment gateway?
  **Answer:** one subscription per owner account, priced by branch count; payments through Razorpay (to build).
- [x] **Q4.** Will branch staff (receptionists) need their own logins, or only the owner?
  **Answer:** yes, with two roles: Manager and Staff.
- [x] **Q5.** Where is the production Postgres hosted, and are backups on?
  **Answer:** there's no production database yet. Choose a managed Postgres with daily backups before launch (O7).
- [x] **Q6.** Does the Render instance sleep when idle? This affects O4.
  **Answer:** no, it stays up.
