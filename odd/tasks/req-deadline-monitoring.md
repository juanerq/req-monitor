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
- [ ] T1 (delegated direct; preparation and multi-file write triggers): Derive active reply deadline from comments with deterministic parsing and cycle tests; preserve status behavior. Acceptance: explicit date from current Operations cycle wins; prior deadline is inactive after requester response; invalid dates do not become deadlines. Verification: focused tests, `pnpm typecheck`. Commit: pending.
- [ ] T2 (delegated direct; multi-file write trigger): Expose the deadline in the monitored-REQ table and add deduplicated daily morning reminders for active due cycles, with tests and short user documentation. Acceptance: visible due date/state or unknown, no repeated same-day reminder, no alert on inactive/finalized cycle; no delivery to Teams during tests. Verification: focused tests, `pnpm typecheck`, structural frontend readback. Commit: pending.

## Delivery and progress
- Strategy: ask-on-risk; user selected stacked-to-main for future reviewable PR slices. No push or PR creation authorized.
- Forecast updated after implementation: approximately 600–700 authored changed lines total, excluding generated files; ask once for chain strategy before the first work-unit commit.
- Reviewed boundary: `f9eb621`; candidate is each committed work unit or later PR slice, never the feature branch.
- RDD mode: on (global). Assessment of the uncommitted worktree is unassessable/high until untracked inventory is declared; no native lifecycle begun. Running authored count: approximately 600–700, pending exact committed count.
- T1/T2 implementation exists, but neither item is checked off: `node --test tests/*.test.ts` passed 15/15 and `git diff --check` passed; `pnpm typecheck` is blocked by missing `tsc`/dependencies, and live browser/Teams checks were not run. Independent verification found three edge cases, corrected with regression tests; a final post-correction independent check remains pending.
- Final independent post-correction read-only verification found no additional high-severity findings; `node --test tests/*.test.ts` passed 15/15, `git diff --check` passed. The missing typecheck remains an explicit pending check.
- Current step: commit separately reviewable T1 and T2 work units, then record commit IDs, exact authored counts, native assessment and any review outcome; do not mark tasks complete while required typecheck remains unavailable.
