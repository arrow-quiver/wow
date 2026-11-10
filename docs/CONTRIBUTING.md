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

## Playing by Blizzard's rules

The addon follows Blizzard's [UI Add-On Development Policy](https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534)
and the game's Terms of Use. Every change keeps to these:

- **Free and open.** No paid features, no hidden or obfuscated code.
- **No ads or donation requests in game.** Nothing the addon says to other players (guild chat, whispers) links to
  or promotes the app or anything else. The app link lives on the addon's own setup page only. (Guild bank
  donations are guildmates giving to their guild, not to us.)
- **No spam, light on the realm.** Lines in guild chat only for real moments (calls to arms, celebrations), each once,
  never in instances, each behind an option. Whispers only when the player clicks. Roster requests at most once a
  minute.
- **No automation.** Anything the game protects (buying, inviting, chat to public channels) happens on the player's
  own click, one action per click (the auction house buy list asks once, then one purchase per click).
- **No taint.** Our own frames only: never Blizzard's StaticPopup, UIErrorsFrame or raid-warning frames (use
  `ns.confirm` and `ns.notice` from `Skin.lua`), never replace Blizzard functions (use `hooksecurefunc`), never
  register `COMBAT_LOG_EVENT_UNFILTERED` (the game blocks the addon at load). `addon-war.test.js` checks the sources.

## Character names

Some realms (WoW Forever) show a surname after the name: the roster, `/who`, the raid roster, chat lines and system
messages say "Gorm Tshabalala", while `UnitName("player")`, whispers and every shared record use "Gorm". The
character is always the first word. In the addon, take names from the game with `string.match(n, "^([^%-%s]+)")`
(no realm, no surname); in the app, `baseName` from `shared/names.js`. Migration 32 merged the roster's surname copies
into the real characters.
