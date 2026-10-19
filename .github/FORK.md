# Fork notes

This repository is a fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip).
It follows upstream `master` and keeps a short list of CI changes so that its own pull requests are green.
Read `CONTRIBUTING.md` and `AGENTS.md` for the upstream rules. They still apply here.

## CI changes in this fork

- **Own trusted-workflow pin.** `.github/workflows/pr.yml` calls this repository's
  `.github/workflows/pr-trusted.yml` at the immutable commit `14b4baa0`, not upstream's pinned
  commit. This keeps the runner policy of this fork local, and it keeps the trust boundary immutable.
  The snapshot is based on upstream `03609aa6`.
- **Pinned runners.** Every workflow runner is pinned to `ubuntu-24.04`, not `ubuntu-latest`.
  A `latest` label moves under a workflow without notice.
- **GHCR cache references.** The Docker workflow lowercases the repository path before it builds a
  cache reference. GHCR rejects an uppercase path, and the owner name `Automancer-Ltd` has uppercase
  letters.
- **commitperclip PR Review.** The commitperclip gates need the commitperclip GitHub App
  (app id 3718661, owner `paperclipai`) installed on this repository, plus its private key in the
  `COMMITPERCLIP_KEY` repository secret. This fork has neither, so the workflow skips the token step,
  the quality-gate step and the failure step, and it writes a notice that names the gates that did not
  run. The `Dependency Review` step is independent of the key and still runs.

- **Release workflow.** The automatic canary (push to master) and nightly (schedule) publish jobs run only on
  `paperclipai/paperclip`. They publish `@paperclipai/*` to npm by trusted publishing, which belongs to the
  upstream repository. This fork has no npm access, so those jobs failed with ENEEDAUTH on every push.
  Manual beta and stable dispatches are unchanged.

## Turn the commitperclip gates on

1. Install the [commitperclip app](https://github.com/apps/commitperclip) on this repository.
2. Add the `COMMITPERCLIP_KEY` repository secret. Its value is the private key of that app.

The `commitperclip PR Review` workflow then runs every gate, with no further change.

## Merge checks

This fork has no branch protection. `git push` to `master` is open to writers of this repository,
and a red check does not block a merge. Keep the checks green anyway: read the check list, and do not
merge on red.
