# Contributing: branches and pull requests

**`main` is the trunk.** It is the default branch, every release is tagged from it, and every change reaches it
through a pull request. Nobody pushes straight to `main`.

## The routine

1. Start from an up-to-date `main`:
   ```bash
   git fetch origin
   git switch -c feature/<short-name> origin/main
   ```
   Name branches by kind: `feature/…`, `fix/…`, `docs/…`, `theme/…`.
2. Commit, run the tests (`GUILDCAMP_NO_SCAN=1 npm test`), and push the branch.
3. Open a pull request **into `main`**. With the GitHub CLI:
   ```bash
   gh pr create --base main --head feature/<short-name>
   # or, where GraphQL isn't available, the REST API:
   gh api repos/arrow-quiver/wow/pulls -f base=main -f head=feature/<short-name> -f title="…" -F body=@pr.md
   ```
4. Say in the description what changed, how it was tested, and anything a reviewer should check by hand (on a real
   game client, for example).
5. Merge into `main` on GitHub. Delete the branch after it's merged.

## Always onto `main`

- **Every pull request targets `main`.** Not `next`, and not another feature branch.
- **Work that depends on an open PR** branches from that PR's branch (so it has the code it needs) but still opens
  against `main`. Say "Built on #N, merge that first" at the top of the description. Until #N is merged, the PR shows
  both commits; afterwards only its own.
- **Keep the branch current** by rebasing on `origin/main` (`git rebase origin/main`, then
  `git push --force-with-lease`) when `main` moves and the PR conflicts. Only force-push your own feature branches.
- Don't use GitHub's stacked pull requests: a PR in a stack can't have its base changed later.

## `next` is retired

`next` was the branch for the move to the desktop app. All of it is in `main` now, so new work never goes to `next`.

## Releases

Releases are made from `main` after the pull requests are merged: see [RELEASING.md](RELEASING.md).
