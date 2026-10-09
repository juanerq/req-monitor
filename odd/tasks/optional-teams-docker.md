# Optional Teams and Docker startup

## Objective
Run the monitored-REQ dashboard and scheduler without a Teams webhook or a local `.env`, while preserving opt-in Teams notifications and making the Docker image build with the current source.

## Problem and why
Compose currently requires an absent `.env`, the Dockerfile omits the imported `deadline.ts`, and the monitor treats a missing webhook as a failed alert rather than an intentionally disabled integration. This prevents a web-only deployment from working predictably.

## Scope and constraints
- Missing or blank `TEAMS_WEBHOOK_URL` disables Teams delivery without failing REQ monitoring, result persistence, dashboard display, or scheduled checks.
- A supplied but invalid webhook remains an error. `--dry-run` simulates alerts without a webhook; explicit `--test-notification` without a webhook reports an actionable failure.
- Preserve honest notification state while disabled: do not record an unsent delivery, and allow a pending/finalized alert when notifications are enabled later; no real Teams send in tests.
- Compose accepts an absent `.env`, yet honors one if present; document optional local webhook setup. Keep API bound to host loopback.
- Dockerfile includes every imported source required for `pnpm typecheck`; avoid live registry/portal/browser/Teams calls. Do not push, publish, or edit unrelated files.

## Tasks
- [x] T1 (delegated direct; preparation and multi-file write): Treat a missing webhook as disabled notification delivery while keeping monitor state and dashboard results correct. Acceptance: disabled-mode state is persisted without false delivery; enabling later sends the current actionable event; invalid configured URL still fails. Verification: RED (3 focused failures) → GREEN (`node --test tests/reminder.test.ts` 10/10, `node --test tests/*.test.ts` 19/19); `pnpm typecheck` and `git diff --check` passed; `--test-notification` without webhook failed clearly. Native assessment: medium; RDD off, no receipt. Commit identity: pending.
- [ ] T2 (delegated direct; multi-file write): Make Compose `.env` optional and include `deadline.ts` in the Docker build; document web-only and Teams-enabled startup. Acceptance: `docker compose config -q` succeeds without `.env`, Dockerfile references required source, setup stays loopback-only. Verification: `docker compose config -q`, `pnpm typecheck`, focused tests, static Dockerfile readback; image build pending if registry access is not authorized. Commit: pending.

## Delivery and progress
- Implementation route: delegated direct. Forecast about 200–350 authored changed lines; strategy ask-on-risk, chain strategy only if forecast/running count grows beyond about 400.
- Branch: `fix/optional-teams-docker` from `04a9420`. Reviewed boundary: `04a9420`. Clone-local RDD switch currently off by prior explicit user choice; do not change it automatically.
- Running authored count, commits and next step: T1 behavior ready to commit; T2 pending. No live browser/Teams calls or remote operations performed.
