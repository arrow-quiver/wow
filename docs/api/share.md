# Share API

Guild data the app shares through the addon in game: what is waiting to go out, what the game refused, changes in
my name that this computer didn't make, and a Discord webhook an officer shared. Implemented in
`app/src/core/routes/share.js` over `app/src/core/sharing.js` and `share/*.js`. The protocol is
[SHARING.md](../SHARING.md); conventions (errors, roles, times) are in [core.md](core.md). The Addon & sync page
and Camp use these routes.

## How a change travels

1. A route that changes shared data (a sign-up, a notice, a raid lock …) queues a record with `sharing.queue()`.
   That writes an **outbox entry** (`share_outbox`, state `queued`) and a provisional record, and remakes the rows
   at once.
2. The app rewrites the inbox for the addon. The addon sends the entry the next time the player logs in or types
   `/reload`, outside instances, on a character that may send it. When the inbox's folder was made while the game
   was running, only a game restart loads it (sync status `restartNeeded`, SHARING.md §2).
3. At the next upload the addon's acknowledgement arrives:
   - `ok,<v>,<author>` → state `sent`. The record is stored as this player's, and the Discord post goes out (when
     a webhook is set in Settings).
   - `wait,<reason>` → state `waiting` with a note (an officer character is needed, I'm in a dungeon …).
   - `no,<reason>` → state `refused` with a note. The rows are made again without the change.
4. A newer version of the same record from someone else also refuses my pending entry: `Someone already closed
   or cancelled this. Check it and try again.` when that version is final (a close or cancel), else `Someone
   changed this in the meantime. Check it and try again.`
5. A cancelled or refused entry just makes the rows again without it: a new raid, request or post that never went
   out disappears, and a first loot list, bank character list or rank setting goes back to what was there before.

The notes are the plain lines from SHARING.md §2 and a few more:

| State | Reason | Note |
|---|---|---|
| `queued` | | `Saved. It goes to your guild the next time you log in or type /reload.` |
| `waiting` | `officer` | `Log in on an officer character to send this.` |
| `waiting` | `gm` | `Log in on your Guild Master character to send this.` |
| `waiting` | `link` | `Log in on <anchor> once so guildmates know your characters are yours.` |
| `waiting` | `instance`, `combat` | `Waiting until you leave the dungeon.` |
| `waiting` | `guild` | `Log in on a character in this guild to send this.` |
| `waiting` | other | `Waiting for the game to send this.` |
| `refused` | `stale` | `Someone changed this in the meantime. Check it and try again.` |
| `refused` | `final` | `Someone already closed or cancelled this. Check it and try again.` |
| `refused` | `expired` | `This waited too long and was not sent.` |
| `refused` | `rank` | `Only officers can make that change.` |
| `refused` | `size`, `oversize` | `This change is too large to send.` |
| `refused` | other | `The game did not send this change.` |

Entries that are replaced by a newer change to the same record, or cancelled, become `dropped` and are no longer
listed. Finished entries are deleted after 30 days.

---

## `GET /api/share/status` (guild)

```json
{
  "enabled": true,
  "pid": "Grimtusk.p4m7",
  "peers": 7,
  "records": 1368,
  "lastHello": "2026-11-07T18:00:10.000Z",
  "lastExchange": "2026-11-07T18:00:30.000Z",
  "outbox": [
    { "op": "o1h2ab", "id": "RT:k3f9a2", "type": "RT", "summary": "Molten Core Thursday: locked", "state": "waiting",
      "note": "Log in on an officer character to send this.", "createdAt": "2026-11-07 18:10:00", "sentAt": null },
    { "op": "o1h3cd", "id": "su:k3f9a2:Grimtusk.p4m7", "type": "su", "summary": "Sign-up for Molten Core Thursday: coming as tank",
      "state": "queued", "note": "Saved. It goes to your guild the next time you log in or type /reload.",
      "createdAt": "2026-11-07 18:12:00", "sentAt": null },
    { "op": "o1h1ef", "id": "AN:q2w8zz", "type": "AN", "summary": "Notice: Raid sign-ups open Sunday", "state": "sent",
      "note": null, "createdAt": "2026-11-07 12:00:00", "sentAt": "2026-11-07 17:58:00" }
  ],
  "refused": [
    { "op": "o1h0gh", "id": "LL:2dv8n1", "type": "LL", "summary": "Loot list for Molten Core", "state": "refused",
      "note": "Someone changed this in the meantime. Check it and try again.", "createdAt": "2026-11-06 20:00:00",
      "sentAt": "2026-11-07 17:58:00" }
  ],
  "authorChecks": [
    { "id": 3, "summary": "Sign-up for Molten Core Thursday: not coming", "via": "Velanne",
      "at": "2026-11-07 18:00:00", "kind": null, "count": 1 },
    { "id": 4, "summary": "Character Grimtusk lists Velanne as your character", "via": "Velanne",
      "at": "2026-11-07 18:00:00", "kind": null, "count": 1 },
    { "id": 5, "summary": "5 changes of a kind this version doesn't know", "via": "Velanne",
      "at": "2026-11-07 18:05:00", "kind": "unknown", "count": 5 },
    { "id": 6, "summary": "Your player id is made on Velanne, who isn't one of your characters", "via": null,
      "at": "2026-11-08 09:00:00", "kind": "pid", "count": 1 }
  ],
  "webhookOffer": { "from": "Grommash", "at": "2026-11-07T17:00:00.000Z" }
}
```
- `enabled`: the addon has reported sharing statistics for this guild at least once (sharing has started).
  Before that `peers` is 0 and the two times are `null`.
- `pid`: my player id in the current guild (ids are per guild, SHARING.md §3), or `null` before any of my
  characters in it is known.
- `peers`: guildmates the addon heard recently. `records`: records stored here for the guild (state `ok`); it
  drops as the app drops records every addon has expired (SHARING.md §11). `lastHello` and `lastExchange` are ISO
  8601, from the addon's own statistics.
- `outbox`: entries `queued` or `waiting`, and entries `sent` in the last day, newest first (up to 200). `type` is
  the record type (lowercase = member data, UPPERCASE = officer data). `summary` is a one-line description.
  `createdAt` and `sentAt` are SQLite UTC times.
- `refused`: the newest 50 refused entries. For a refused entry `sentAt` is when the refusal arrived.
- `authorChecks`: open checks, newest first (up to 50). `via` is the guildmate who passed the record on to my
  addon (the first sender), or `null`. `kind` and `count` say what the check is about (table below). A check
  opens for a record in the name of one of my characters (in this guild, or with no guild known) that came
  through an addon store, newer than `share_since:<guild id>` (when this computer first shared in the guild), of
  a type the addon doesn't build itself (not `ch`, `rc`, `gb`, `bk`, `sh` or `ca`), whose version this computer
  didn't make: not queued or waiting in its outbox, and not in its log of my own versions (versions whose `ok`
  arrived, versions answered "It was me", and at a fresh start the records in my name it held). SHARING.md §3
  and §5 have the rules. A fresh start keeps the open checks and doesn't move `share_since`.
- `webhookOffer`: an officer shared a Discord webhook and I am an officer who hasn't answered yet; otherwise
  `null`. `from` is the character that shared it.
- Before the guild is known this route answers `403 NO_GUILD` like every guild route.

Author check kinds, and what the renderer shows for each (`lib/status.js` `authorCheckView`; a kind it doesn't
know reads like `null`):

| `kind` | About | Text | Buttons (`mine` · `undo`) |
|---|---|---|---|
| `null` | One record in my name; or my anchor's `ch` listing characters this computer doesn't know as mine (summary `Character Grimtusk lists Velanne as your character`) | "A change in your name arrived that this computer didn't make: <summary>. Passed on by <name>." | "It was me" · "Undo it" |
| `unknown` | `count` records of types this version doesn't know, from one sender (one open check per sender, up to 200 records). Summary `5 changes of a kind this version doesn't know`, or the usual one for a single record | The same line, starting "Changes in your name arrived…" when `count` is over 1 | "It was me" · "Undo it" |
| `pid` | The repair after an update: my player id is made on a character that isn't mine (`via` is `null`) | "<summary>. Is that character yours?" | "Yes, it's mine" · "No, make a new id" |
| `repair` | The repair after an update: characters an older version linked to me (summary `Velanne was linked to you as your character`; `via` is `null`) | "<summary>. Is that right?" | "Yes, mine" · "No, not mine" |

## `POST /api/share/outbox/:op/cancel` (guild)

Drops a change that is still `queued` or `waiting`. The rows are made again without it, so the page shows what it
showed before. No body.
```json
{ "ok": true, "message": "Change dropped. It will not be sent." }
```
| Status | When | `error` |
|---|---|---|
| 404 | `op` isn't an outbox id (`o` plus base36) | `"That change was not found."` |
| 409 | Already sent, refused, dropped, or another guild's | `"That change already went to your guild, or was dropped."` |

Once the addon has read the inbox, an entry it already sent goes out anyway; cancelling only stops what hasn't
gone yet.

## `POST /api/share/author-checks/:id` (guild)

Answers an author check.
```json
{ "action": "mine" }
```
- `mine` ("It was me"): the check closes; nothing changes, and the version (every version of an `unknown` group)
  goes into the log of my own versions, so it is never asked about again, also after a fresh start.
  → `{ "ok": true, "message": "Thanks. Nothing changes." }`
- `undo` ("Undo it"): queues my previous version of the record again (when the version before was mine), or a
  tombstone, on top of the version the addon holds, then closes the check. Officer records wait for an officer
  character as usual.
  → `{ "ok": true, "message": "Saved. It goes to your guild the next time you log in or type /reload." }`
- `undo` on records of a type this version doesn't know: nothing can be sent, so the check just closes, for every
  record in it.
  → `"Closed. This version can't undo that kind of change. It goes away by itself within 14 days."` (one record)
  or `"Closed. This version can't undo those changes. They go away by themselves within 14 days."` (a group)

A check about my anchor's list of characters answers differently:
- `mine`: the names count as mine from now on (app_settings `share_my_alts:<guild id>`), are linked to my player,
  and go in my anchor's `ch` from the next login on. → `"Thanks. Velanne now counts as yours."` (`"Thanks. Velanne
  and Bob now count as yours."`)
- `undo`: nothing is queued (nobody was linked, and my addon puts my own list back).
  → `"Saved. Log in on Grimtusk once to put your own list back."`

A `repair` check (characters an older version linked to me; SHARING.md §3):
- `mine`: the names count as mine and are linked to me again; what they wrote in my player id's name and was set
  aside is used again at once. → `"Thanks. Velanne now counts as yours."`
- `undo`: they stay unlinked. → `"Saved. Velanne no longer counts as yours."` (`"Saved. Velanne and Bob no longer
  count as yours."`)

A `pid` check (my player id is made on a character that isn't mine):
- `mine`: that character counts as mine and the id stays. → `"Thanks. Velanne now counts as yours."`
- `undo`: the id goes and a new one is made on a character of mine in the guild; every row is made again, and my
  sign-ups for raids still to come are queued again under the new id. → the saved line above, or `"Saved. Log in
  on a character of yours in this guild to get your own player id."` when no character of mine is known in the
  guild yet. Records made under the old id keep showing under it.

While a news folder waits for a game restart, the renderer shows the saved line as "Saved. It goes to your guild
after you restart World of Warcraft. A /reload isn't enough the first time." (SHARING.md §2).

| Status | When | `error` |
|---|---|---|
| 404 | Unknown id or already answered | `"That change was already handled."` |
| 400 | `action` is neither | `"Pick "It was me" or "Undo it"."` |

## `POST /api/share/webhook/accept` (officer)

Takes the webhook an officer shared. The core does not save it: the renderer saves it with
`gc.settings.set({ discordWebhook: url })`.
```json
{ "url": "https://discord.com/api/webhooks/123/abc" }
```
No offer waiting → `404 "There is no shared webhook waiting."`

## `POST /api/share/webhook/dismiss` (guild)

"Not now": closes the offer without saving anything. → `{ "ok": true }`

## `POST /api/share/webhook/share` (officer)

Sends the webhook saved in my Settings to the other officers, as a `WH` record on the OFFICER channel (it waits
for an officer character; the addon re-sends it once a day at login so officers who were offline get it). Only
officers' apps keep it. Audit `shared the Discord webhook`.
```json
{ "ok": true, "op": "o1h4ij", "message": "Saved. It goes to your guild the next time you log in or type /reload." }
```
No webhook in Settings → `400 "Add a Discord webhook in Settings first."`

---

## Other things that queue records

Every route below changes shared data through `sharing.queue()`; their pages are in the other files.

| Action | Route | Record |
|---|---|---|
| Schedule a raid or event | `POST /api/raids` | `RD` |
| Lock, unlock, cancel, close | `POST /api/raids/:id/lock` · `unlock` · `cancel` · `close` | `RT` (`l`, `o`, `x`, `d`) |
| Sign up; reserve (only with a sign-up: the reserves travel on it) | `POST /api/raids/:id/signup`; `/reserves` | `su` |
| Award loot | `POST /api/raids/:id/award` | `LA` |
| Edit a loot list | `POST /api/loot/items`, `DELETE /api/loot/items/:id` | `LL` |
| Call to arms | `POST /api/ctas` | `ca` |
| Post or delete a notice | `POST /api/announcements`, `DELETE /api/announcements/:id` | `AN` or its tombstone |
| Crafting request; cancel; done | `POST /api/requests`; `/:id/cancel`; `/:id/done` (by the requester) | `cr` |
| Claim; done; withdraw (as crafter) | `POST /api/requests/:id/claim` · `done` · `withdraw` | `cl` |
| Partner post; close it | `POST /api/partners`; `/:id/close` | `lp` or its tombstone |
| Bank request; cancel | `POST /api/bank/requests`; `/:id/cancel` | `bq` |
| Bank request sent or declined | `POST /api/bank/requests/:id/sent` · `declined` | `BH` |
| Bank characters | `PUT /api/bank/alts` | `BC` |
| Start or close a drive; hand in | `POST /api/drives`, `/:id/close`; `/:id/give` | `DR`; `dc` |
| Officer and relay ranks | `PUT /api/guild/settings` | `CFG` |
| My main character | `POST /api/characters/:name/main` | none: the inbox's `me` changes and the addon rewrites my `ch` |
| "It was me" on a check about my anchor's list | `POST /api/share/author-checks/:id` | none: the inbox's `me.alts` changes and the addon rewrites my anchor's `ch` |
| "Undo it" on a `pid` check | `POST /api/share/author-checks/:id` | `su` again under my new id, for raids still to come; the inbox's `me.pid` changes |

Some records are written without a route: `pr` (my Auctionator prices, once a day after an upload), `LY` (an SR+
checkpoint, written by an officer's app when the newest one is over 14 days old) and, in game, everything the
addon builds itself (`ch`, `rc`, `gb`, `bk`, `sh`, and `ca` from `/wow cta`).
