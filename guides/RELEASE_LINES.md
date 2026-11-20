# Release lines

Loom is a standalone MemberJunction package workspace (not an MJ OpenApp — it has no `mj-app.json`
or OpenApp SQL migrations). It adopts the MemberJunction release-line branch model adapted for
standalone semantic-versioned lines (`lts/<major>.<minor>`).

| Branch | Purpose | What lands there |
|---|---|---|
| `next` | Active development (default branch) | All new work, first |
| `lts/X.Y` | Release / LTS line for `X.Y.x` | Cherry-picked backports from `next` |

## The line status record

[`release-lines.json`](../release-lines.json) lists each standalone release line: its branch
(`lts/X.Y`), the semver it was cut at (`version`, never changed once cut), whether it is `open` or
`lts`, and whether it releases through `main` (dist-tag `latest`) or from its own branch (dist-tag
`lts-X.Y`). CI always reads the authoritative copy on `next`. Freezing a line to `lts` is a support
decision: have one of the owners in `.github/CODEOWNERS` review the change.

A line is `open` (features and fixes backported from `next`) or `lts` (fixes only). An LTS line
never reopens.

## Daily flow

1. Open your PR against `next`.
2. Add a `backport lts/X.Y` label for each release line the change should reach (before or after
   merging). When the PR merges into `next`, the backport workflow opens one cherry-pick PR per
   labelled line.
3. If a cherry-pick hits a conflict, the workflow opens a draft PR for you to finish. If you add a
   commit of your own to resolve the conflict, add the `backport-adjusted` label so reviewers and
   `lines: on next first` recognize the conflict-resolution commit.
4. Direct PRs into `lts/*` that bypass `next` are rejected by `lines: on next first`.

## The checks

| Check | On | What it enforces |
|---|---|---|
| `lines: record` | PRs into `next` | `release-lines.json` is valid, line identity never changes, LTS never reopens, backport labels name real lines, and script unit tests pass |
| `lines: on next first` | PRs into `lts/*` | Every commit carries `(cherry picked from commit <sha>)` with `<sha>` on `next`; conflict fixes need `backport-adjusted`; line-cut PRs require a maintainer/admin-applied `line-cut` label |
| `Build & Test` | All PRs (`next`, `main`, `lts/*`) | Full monorepo build, typecheck, domain vocabulary check, and tests |

## Cutting a new release line

1. On `next`, add the new line to `release-lines.json` (`status: "open"`, `version: "X.Y.0"`). Have
   one of its `CODEOWNERS` review and merge.
2. Create the `backport lts/X.Y` label and ensure the `protect-lts` ruleset covers `refs/heads/lts/*`.
3. Push `lts/X.Y` from `next`.
4. Open a `ci/cut-lts-X.Y` PR into `lts/X.Y` setting `.github/CODEOWNERS` to `* @bg-BC @rkihm-BC`,
   apply the `line-cut` label (maintainer/admin only), and request code-owner review.
