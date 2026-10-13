# Portal REQ details

## Objective
Show the portal's observed request status and stored details for monitored REQs without inventing values, including a per-row detail control.

## Problem and why
The table emphasizes a derived conversation status instead of the portal's displayed status, the microservice extractor assumes one DOM structure, and request descriptions and applicant details are discarded before they reach the dashboard. Users cannot inspect the portal information from each monitored row.

## Scope and constraints
- Extract only observed values from monitored request pages: portal status, microservices explicitly named in the detailed description, request description and instructions, requester name/user ID/email/phone, request dates, and relevant request detail fields. Missing values remain unavailable, never synthesized or translated from workflow state.
- Keep the separate derived conversation status for reminders and alerts; do not replace its semantics. Never scrape unrelated REQs.
- User explicitly authorized showing applicant personal information in the local detail view. Treat stored results as sensitive: avoid raw HTML injection, credential disclosure, remote transmission, and real portal access during development; retain safe local API access behavior.
- Include an accessible per-row detail control and keep stored results useful without an extra portal request. Use synthetic fixtures, not real requester data, in tests and documentation.
- Preserve the unfinished authentication work on its original branch. This feature is isolated in `feat/req-portal-details` at the sibling worktree, based on `4f1ffb9`. Do not push, merge, or open a PR.

## Tasks
- [x] T1 (delegated direct; parser + persistence + tests): Capture observed portal status and request fields with labeled DOM extraction and microservice parsing, propagate typed results to stored JSON, and test with synthetic detail markup. RED → GREEN observed; 18 focused tests and 42 full tests passed after temporarily linking existing local dependencies, `pnpm typecheck`, Docker source inventory test and `git diff --check` passed. Final live extraction remains a separate T3 check. Commits: `30f8b99` (`feat(monitor): capture observed portal request details`), `09dd388` (`fix(monitor): recognize applicant field labels`).
- [x] T2 (delegated direct; dashboard + tests): Render literal portal status and an accessible per-row detail control with safe text/link rendering, explicit unavailable values, applicant details, and retained conversation status; document privacy and recheck behavior. RED → GREEN observed; 4 focused dashboard tests, 39 full tests, typecheck and diff check passed. Final live UI check remains a separate T3 check. Commit: `b9eba41` (`feat(dashboard): show stored portal request details`).
- [ ] T3 (read-only verification): When Docker is available, validate final extractor and dashboard against only the authorized REQ using the local session, return redacted field-presence results, and correct any demonstrated mismatch in the same authorized scope. No portal mutations or new identity/phone assumptions. Verification: observed status/microservice fields or explicit missing data; no fabricated success.

## Delivery and progress
- Route: delegated direct for T1/T2 (multi-file writer, preparation tied to write). Forecast: roughly 450–650 authored changed lines across tasks; strategy `ask-on-risk`, chain strategy `stacked-to-main` selected by user. Commits remain local; PR, push and merge require separate authorization. Size is advisory, not a code-golf constraint.
- Running authored changes: T1 about 576 lines plus an 83-line correction, T2 about 164 lines; first slice `30f8b99`, second slice `b9eba41` + `09dd388`. PRs are not created. The feature branch starts at `4f1ffb9` (optional-Teams/Docker branch), not at `main`; reconciling that base is required before planning PRs toward `main`.
- RDD: clone-local off by user choice. Do not toggle or run native review.
- Engram mirror `odd/req-portal-details/tasks`: pending; memory service refused writes because session registration could not be confirmed. Keep the local document authoritative until it can be resynchronized.
- User authorized read-only access to the single provided REQ with the existing mounted session; prior inspection verified real `dwp-event-details` fields and `es-CO` status rendering. No portal mutation, secret dump, Teams or other remote operation is authorized. Latest post-fix live verification was unavailable because the local Docker daemon could not be reached; keep final extraction proof pending.
- Independent verification found description text could masquerade as portal status, nested definition labels were missed, and long fields were silently truncated; corrected with synthetic browser-DOM tests. Final corrected extraction remains unverified on the live page; do not claim this example is captured yet.
- Earlier pre-fix sanitized live extraction found the portal page displayed `En curso` but parser status was absent, and microservice/user ID/phone were absent. Later synthetic corrections target status, bullet-prefixed microservice extraction, and exact applicant labels; missing values remain unavailable rather than inferred. Do not claim final live fields until rechecked.
- Follow-up correction: exact observed phone labels (`Pedido para teléfono`, `Numero de Contacto`) and a strictly grouped requester-header user ID are recognized in synthetic DOM tests. 18 focused and 42 full tests passed with typecheck; real header structure still awaits T3. A missing label stays unavailable.
- Next step: T1 implementation, verified checks, delivery strategy choice before commit; then T2 and evidence/mirror updates.
