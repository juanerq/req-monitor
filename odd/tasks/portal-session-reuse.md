# Secure portal session reuse

## Objective
Reuse the portal session from the local Docker volume, retain only the login username for convenience, and require a fresh password only when silent portal reuse does not work.

## Problem and why
The application already stores Playwright browser state, but it does not remember the login username, does not explicitly protect that state file on write, and offers no clear web indication that a stored session might have expired. A saved session is a credential, not proof of access or an indefinite refresh token.

## Scope and constraints
- Never persist, log, expose through a read API, or place the password in a Docker environment variable. Retain only a validated username and the existing Playwright session in the local mounted auth directory.
- Write state atomically with restrictive file permissions; protect both new and legacy saved session files where safe. Keep CLI and API aligned on configured AUTH_FILE.
- Reuse browser state first; let the portal silently renew only if its existing browser flow supports it. Do not invent refresh endpoints, assume indefinite access, or turn network/portal errors into claims of expired credentials.
- The web UI may display saved username and local session availability without disclosing tokens. If the portal requires a fresh login, use the existing Acceso flow to request the password interactively and clear it after use.
- No live portal login, browser automation, external authentication, or credential-file content inspection in this task. User subsequently authorized local integration into `main` of this feature, optional Teams/Docker and REQ details; no push.

## Tasks
- [x] T1 (delegated direct; preparation and multi-file write): Save username and Playwright session safely after a successful login, reuse the same AUTH_FILE path from CLI and API, and test atomic permissions/failure handling without secrets. RED → GREEN observed; 20 focused auth tests, 43 full tests, typecheck, Compose config and Docker context static tests passed. Existing default auth directory normalization is owner-bound; arbitrary permissive overrides remain rejected. Commit: `dda0a70` (`feat(auth): persist local portal session securely`).
- [x] T2 (delegated direct; multi-file write): Expose saved username label and truthful local session availability in the web UI, distinguish local state from verified portal access, and document re-login fallback without claiming automatic renewal. RED → GREEN observed; 2 focused dashboard tests, 43 full tests and typecheck passed. Real login not attempted. Commit: `e959860` (`feat(dashboard): show local portal session state`).
- [ ] T3 (external verification): Confirm rebuilt image and live renewal only after required network/build and credential scope is explicitly authorized; never infer success from static checks. Offline Docker build failed at step 3/8 without an established safe cause; no retry or remote access was used.

## Delivery and progress
- Implementation route: delegated direct. Original forecast about 250–400 authored changed lines; actual changes exceed 400 because of tests and Docker context hardening. Strategy `ask-on-risk`, user selected `stacked-to-main` for related REQ details and explicitly requested local integration into `main`; no PR, push or remote delivery is authorized. Size is advisory, not a code-golf constraint.
- Branch: `feat/portal-session-reuse` from `4f1ffb9`. Reviewed boundary: `4f1ffb9`. RDD clone-local off by explicit user choice; do not toggle it.
- Running authored changes: about 693 lines in `dda0a70`, plus about 64 in `e959860`; work units remain on the feature branch until local integration. PRs were not created.
- Actual portal refresh capability is unverified: no silent renewal mechanism is asserted. No remote operation or real credential use is authorized for this integration. The `.har` file remains ignored and uninspected.
- Docker context uses an explicit allowlist, including `req-details.ts` for subsequent integration and only three named web files; `.env`, `.git`, Playwright auth, artifacts, runtime and HAR remain excluded. Static context test observed RED → GREEN; image build offline failed at step 3/8.
- Verification: `node --test tests/auth-session.test.ts` (20/20), `node --test tests/dashboard.test.ts` (2/2), `node --test tests/docker-config.test.ts` (3/3), `node --test tests/*.test.ts` (43/43), `pnpm typecheck`, `git diff --check`, `docker compose config -q` passed. Synthetic API server ran with scheduler and startup monitor disabled; no portal or Teams request.
- Engram mirror `odd/portal-session-reuse/tasks` pending because memory rejected session registration; local document is authoritative. Pending: local integration and commit identities, live portal renewal and Docker image build.
