# REQ deadline monitoring

## Objective
Show the explicit response deadline on monitored REQs and issue daily morning reminders for active unanswered cycles.

## Problem and why
The portal can state a precise deadline in an Operations comment, but the current dashboard and notification logic do not track it. A later requester reply ends that waiting cycle; a later Operations reply begins another.

## Scope and constraints
- Only monitored REQs. Parse explicit dates such as `Esperamos la información antes del día 09/10/2026 11:59 p.m.` in the latest relevant Operations comment, using `America/Bogota`; no environment variable for the actual deadline.
- A requester reply ends the active waiting cycle; the next Operations reply starts a fresh cycle. Do not call a stated deadline an actual closure event.
- If an Operations reply has no explicit date, do not invent a precise closure time. Three Colombian business days is a business-rule fallback only if derivable safely from the comment timestamp and validated by tests.
- Morning reminders only while waiting on the requester, at most once per REQ and active cycle per local date. Respect existing scheduling and avoid exposing credentials or sending real notifications in tests.
- Leave unrelated pre-existing changes in `.atl/` untouched; do not commit `.codegraph/`.

## Tasks
- [x] T1 (delegated direct; preparation and multi-file write triggers): Derive active reply deadline from comments with deterministic parsing and cycle tests; preserve status behavior. Acceptance: explicit date from current Operations cycle wins; prior deadline is inactive after requester response; invalid dates do not become deadlines. Verification: `node --test tests/*.test.ts` 15/15, `pnpm typecheck` passed after dependencies were installed by the user; `git diff --check` passed. Commits: `496245e` (347 authored lines) and compatibility fix `9172861` (3 authored lines). Native assessment: medium, review switch off at closure; no receipt.
- [x] T2 (delegated direct; multi-file write trigger): Expose the deadline in the monitored-REQ table and add deduplicated daily morning reminders for active due cycles, with tests and short user documentation. Acceptance: visible due date/state or unknown, no repeated same-day reminder, no alert on inactive/finalized cycle; no delivery to Teams during tests. Verification: `node --test tests/*.test.ts` 15/15, `pnpm typecheck`, `git diff --check`, and structural frontend readback passed. Commit: `2def464` (326 authored lines). Native assessment: medium; review switch off, no receipt.

## Delivery and progress
- Strategy: ask-on-risk; user selected stacked-to-main for future reviewable PR slices. No push or PR creation authorized.
- Forecast updated after implementation: approximately 600–700 authored changed lines total, excluding generated files; the user selected stacked-to-main. Planned slices: PR 1 `f9eb621..9172861` (T1), PR 2 `9172861..2def464` plus this progress-record commit (T2); no PR created.
- Reviewed boundary: `f9eb621`; candidate is each committed work unit or later PR slice, never the feature branch.
- RDD mode: clone-local off by explicit user choice; global remains on. Before opt-out, the committed-only assessment of `f9eb621..496245e` was unassessable/high and bound preflight STATUS refused `immutable_review_transport_unsupported` before authority mutation. With mode off, explicit-inventory assessments for T1 and T2 commits were medium (`under_budget`); no native approval or receipt exists. Running authored count: 676 authored lines plus this short progress update.
- Independent verification found three edge cases, corrected with regression tests, and post-correction read-only verification found no additional high-severity findings. `node --test tests/*.test.ts` passed 15/15; `pnpm typecheck` passed after user installed dependencies; `git diff --check` passed. Live portal/browser and Teams delivery were not run.
- Current step: delivery remains a human choice; leave unrelated `.atl/` changes and `.codegraph/` untouched. No push or PR creation performed. The three-business-day fallback when no date is stated remains unimplemented because a precise closure time must not be invented.
