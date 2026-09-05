# Estate native admission release

Owner: evening-estate lane; parent Main w2:pN. Campaign stays OFF under every outcome.

## Source and installed baseline

Maintained fork: https://github.com/Waseemilyas/paperclip (created/read back 2026-09-05;
parent paperclipai/paperclip, estate push/admin permission confirmed).
Release baseline is upstream v2026.824.1, commit 8e6edcdfa911151adba26be49a41cf5017b3aade.
Do not merge the newer upstream master into this release.

The installed `paperclipai/dist/index.js` is byte-identical to the official npm
2026.824.1 tarball, SHA-256 `5d730b89518fc1b9c916050c7867608266fb39b9c4c8838dac8f581a8b11807a`.
The CLI resolves `@paperclipai/server` externally; replacing only the CLI bundle would
not install the heartbeat guard.

Compared all shipped runtime JavaScript files in server (420), adapter-utils (61),
and adapter-codex-local (59) with their official 2026.824.1 npm tarballs.
Exactly ten files differ, matching the installed local-patch ledger. File hashes
and upstream tarball URLs: `estate-installed-package-comparison-2026-09-05.json`.
Exact installed diffs against preserved stock backups: `estate-installed-patches-2026-09-05.diff`.
The CLI package metadata was retrieved with the source-retrieval skill, evidence
`/tmp/pi-research/rs-4e58b1fa.json`; runtime tarballs were compared in memory, not installed.

## Changes prepared

- Admission claim/cancel applies only its four flags as a JSONB expression on the
  current database row. It no longer overwrites coalesced wake context from a stale copy.
- Regression suspends a claim at its budget read, coalesces an actual native wake,
  then checks the comment survives ordinary, campaign and admission-cancelled paths.
- Concurrent-cap regression pauses the first count and starts a different actor through
  native wakeup, requiring the second lock attempt before releasing the first count.
- Null/blank saved campaign IDs no longer lock ordinary actor edits/rollback.
  True coordination-only settings and attempts to set safety fields remain board-owned.
- Ported the ten installed patch files: ACP environment scrubbing/provider allowlist;
  optional isolated-workspace reuse and binding; no implicit parent workspace inheritance;
  ambiguous confirmation preservation; terminal skipped-wake suppression/throttle;
  liveness source-status/three-escalation ceiling; runnable owner selection;
  paused/budget-blocked routine deferral/coalescing; Codex local-auth billing classification.

No build or installed runtime change has occurred. These ports need typecheck and
behavioral verification before they are an installable superset of the live package.
The ACP guard manifest in ops must be re-stamped against the built installed module,
then its synthetic child probe must pass before any restart. Preserve the launcher and
its child environment sanitizer; do not copy or expose credentials.

## Verification

Ops PR36 follow-up: 7e37526, 141 focused entry/worker/writer tests pass; its new
unadmitted-worker regression failed before the fix. Paperclip's 13 changed TypeScript
files transpile without syntax diagnostics; `git diff --check` passes. This is not a typecheck.

Paperclip Vitest startup and native server typecheck exceeded bounded 25-second
foreground calls without a verdict. Their processes were checked absent afterwards.
The harness's background task tool refuses this nonpersistent execution context;
detached shell jobs are forbidden by the harness contract. Main has been told to run
long checks in a persistent execution session. No successful Paperclip test/typecheck
or independent follow-up review is claimed.

Required checks, serially, in this checkout:

```
pnpm --filter @paperclipai/server typecheck
pnpm exec vitest run server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts server/src/__tests__/agent-adapter-validation-routes.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000
pnpm exec vitest run server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts --pool=forks --maxWorkers=1 --testTimeout=15000
```

Run relevant workspace, confirmation, routine and adapter behavior checks for the
ported local patches as well; old upstream expectations may need reconciliation with
the installed behavior. Do not mistake an old source check for evidence on this port.

## Pending decisions / gates

- Main's independent follow-up verdict is required before installation. First run the
  checks above in a persistent session and repair failures; review the full ten-file
  installed-patch port as well as the admission fix. Default: no install or actor writes.
- Build/install execution needs that persistent session. Use the repository's package
  release path for server and adapters, not CLI-only `build:npm`. Take the documented
  production backup before data writes; verify health and exact loaded module revision.

After the gate clears, follow `evening-estate-brief.md` and the preserved acceptance
steps. Save exact actor objects securely, configure only four paused actors, read back,
run the bounded test-repository cycle, then restore and re-read all objects. OFF remains
present. No blind retry, other-company opt-in, shared policy activation or datastore restore.
