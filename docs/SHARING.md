# Guild Camp sharing protocol (v1)

Binding spec for how WowGuild addons trade guild data over hidden addon messages, and how the app reads and
writes it. Contract: docs/PIVOT.md. Code that implements it:

```
app/src/shared/sharing.js       codec, rules and derived-state functions (used by core, tests)
addon/WowGuild/ShareCodec.lua   the same codec in Lua 5.1
addon/WowGuild/Share.lua        store, player id, outbox, receive, queues
addon/WowGuild/ShareSync.lua    exchange, pruning and store caps
addon/WowGuild/Collect.lua      my ch, rc, gb, bk and sh records
app/src/core/sharing.js         public API: queue, cancel, importShared, exportOutbox/Me/Seed, status, author checks
app/src/core/share/store.js     clock and skew, who I am (§3), effective records, links between characters and players
app/src/core/share/project.js   records → domain rows, one projector per type
app/src/core/share/queue.js     queue, cancel, ensurePid
app/src/core/share/import.js    importShared (§10 Import)
app/src/core/share/export.js    the inbox's outbox, me and seed (§9)
app/src/core/share/prune.js     dropping records every addon has expired from the app's copy (§11)
app/src/core/share/repair.js    the one-time repair of who I am after an update (§3)
app/src/core/share/text.js      summaries, the plain lines (§2), audit lines, Discord posts
```

## 1. Goals and non-goals

Goals
- Every shared feature of the old server works with no server (record types in §4.3).
- Data spreads through whoever is online, outlives its author's session and converges: peers holding the same
  records show the same state, whatever the arrival order.
- Every receiver enforces officer-only actions from the author's in-game rank; a modified addon cannot create
  or change officer data.
- Never exceed the game's throttle; no storm when 20+ members log in; a bounded store pruned alike everywhere.
- Small and testable: one prefix, five message types, one record shape, no bundled libraries.

Non-goals (v1): signatures; live in-game display of received records (except calls to arms); field-level
merges; sharing the roster, Coach, gold, reputations, ordinary bags and banks or alt search; any traffic inside
instances; WHISPER, PARTY or RAID transport.

## 2. What players see

App action → inbox → sent at the next login or `/reload` outside instances → guildmates online, and on through
them → each guildmate's app after their next logout or `/reload`. The app's lines (the outbox notes come from
`app/src/core/share/text.js`, whose `LINES` the renderer's `SHARE_LINES` repeat):

- "Saved. It goes to your guild the next time you log in or type /reload."
- "New guild data shows here after you log out or type /reload in game."
- "Waiting until you leave the dungeon."
- "Log in on an officer character to send this." / "Log in on your Guild Master character to send this."
- "Log in on Thrallia once so guildmates know your characters are yours."
- "Someone changed this in the meantime. Check it and try again."
- "Someone already closed or cancelled this. Check it and try again."
- "This waited too long and was not sent."
- "A change in your name arrived that this computer didn't make: <summary>. Passed on by <name>." with "It was me"
  and "Undo it" (§5). For my anchor's list of characters the summary is "Character Thrallia lists Jaina as your
  character". Several records of a type this version doesn't know, from one sender: "Changes in your name arrived
  that this computer didn't make: 5 changes of a kind this version doesn't know. Passed on by Jaina."
- From the repair after an update (§3): "Jaina was linked to you as your character. Is that right?" with "Yes,
  mine" and "No, not mine", and "Your player id is made on Jaina, who isn't one of your characters. Is that
  character yours?" with "Yes, it's mine" and "No, make a new id".
- "Sign up first, then pick your reserves."
- "Restart World of Warcraft to load it. A /reload isn't enough this time." (an addon install or update while the
  game may be running) and "Guild news saved for the addon. It shows after you restart World of Warcraft. A
  /reload isn't enough the first time." (a `WowGuild_Inbox` made while the game may be running)
- While a game folder's `WowGuild_Inbox` was made during the game session that still runs, that session never
  loads it, also not after a `/reload` (sync status `restartNeeded`, ARCHITECTURE.md "The file channel"). Until
  Guild Camp sees that session end, the lines that say "log in or type /reload" say instead:
  - "Saved. It goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time."
  - "This goes to your guild after you restart World of Warcraft. A /reload isn't enough the first time." (the
    hint under forms)
  - "Changes marked “Ready to go” go to your guild after you restart World of Warcraft. A /reload isn't enough the
    first time." (Addon & sync) and "Your changes reach the guild after you restart World of Warcraft. A /reload
    isn't enough the first time." (Camp)
  - "A new plan reaches the game after you restart World of Warcraft. A /reload isn't enough the first time."
    (Coach)
  - and the Sync card says "Guild Camp added its news folder in WoW Forever while the game was running. Restart
    World of Warcraft to load it. A /reload isn't enough the first time. Your changes for the guild wait until
    then."

In game:

- "2 officer changes are waiting. Log in on an officer character to send them."
- "1 change is waiting. Log in on Thrallia once so guildmates know Zuljinne is yours."
- "A guildmate has a newer Guild Camp addon. Update it from the Guild Camp app."
- "Sharing with 7 guildmates. 1,368 records. 1 change waiting." (`/wow share`)
- "Sharing with your guild isn't running. Restart World of Warcraft to finish the addon update. A /reload isn't
  enough." (`/wow share` when the sharing files didn't load; `/wow cta` says "Calls to arms can't be sent right
  now." with the same hint)

## 3. Identity

- **Character** = `Ambiguate(name, "guild")`. The game authenticates only the direct sender of a message.
- **Player id (pid)** = `<anchor>.<4 base36>`, for example `Thrallia.p4m7`; the anchor is the character it was
  made on. Ids are **per guild**: an alt in another guild has that guild's own id, made on a character in that
  guild. The app keeps one per guild (app_settings `me_pid:<guild id>`) and makes it on a character of mine known
  to be in that guild (an upload said so, or the guild's roster lists it), my main first, else the most recently
  played; with none known there yet, it makes none. Without an app, the addon makes one. The addon keeps the id
  per partition (`WowGuildDB.shared.guilds[g].pid`, §9).
- **What makes a character mine** is only what this computer saw itself, never a shared record on its own:
  - App: the characters in this computer's own SavedVariables uploads. `characters.game_guild` keeps the in-game
    guild the upload gave, and decides where each one stands in a guild:
    - **In the guild**: the upload gave this guild, or gave none while the guild's roster lists the character.
      It is mine in every way: my main, the alts in my `ch`, the author of my records, the anchor of my player
      id.
    - **Guildless**: the upload gave no guild and the roster doesn't list it. Records it wrote count as mine, but
      it is never my shared main, never in the alts my `ch` lists and never an anchor. It signs my records only
      while no character of mine is known to be in the guild, and the main shown on the members page, the
      character a call to arms is signed with and a loot award's default character prefer one in the guild.
    - **In another game guild**: it doesn't count here at all, and stays off this guild's roster, its counts, the
      members list and the character pickers (its row is kept, so item tooltips and "I can craft" still see it).
  - A `ch` that names my id may also link to me my Battle.net characters on the guild's realm (unless Battle.net
    puts them in another guild) and names I confirmed with "It was me" (app_settings `share_my_alts:<guild id>`);
    Battle.net characters may also anchor an id I adopt.
  - My own upload claims a character that sharing had linked to another player id (a `pid:` or `char:` user):
    that is my second account before both used one id. The player left behind stops being listed as a guildmate
    once it has no character.
  - Addon: the character logged in and the names in this guild's inbox `me.alts`; for adopting an id, also the
    characters of this account (the keys of `WowGuildDB.characters`).
- **Adoption, app.** Only while the app has no id for the guild, at import step 1 (§10), before any record is
  imported. A pid counts only when it was made on one of my characters in the guild (uploads or Battle.net):
  1. an id another PC of mine already uses: named by the live `ch` of one of my characters, and by its anchor's
     own `ch` (not just any `ch` naming a made-up id). When the addon has an id of its own for the guild, only an
     id made on a character this PC doesn't play (one of my Battle.net characters) counts here: the addon stamps
     every character it plays with its own id, and it already looked for a guildmate's copy before making it, so a
     relayed `ch` of such a character naming another id made on it may be a guildmate's invention;
  2. the addon's id for this guild (`shared.guilds[g].pid`), then `shared.pid` from before ids were per guild;
  3. else a new one, at the end of the import or at the next inbox.
  The single `me_pid` from before ids were per guild becomes a guild's id the first time that guild's id is asked
  for, when its anchor is in that guild and mine there (uploaded here, confirmed, or a Battle.net character).
- **Repair after an update** (`share/repair.js`, once, when the core starts; app_settings `share_repair`). An older
  version could let a guildmate's `ch` make a character mine, or adopt an id made on a guildmate's character. For
  every guild:
  - The old single `me_pid` becomes the guild's id where its anchor is in the guild, so it stays in use until I
    answer.
  - A character linked to me with no evidence from an upload of this computer (gold, game guild, or bags that
    can't have come from a shared `bk`: never a bank character's), that is not a Battle.net character of mine
    and that I never confirmed, is unlinked and linked again as its own `ch` says (never to me). Records it wrote
    in my id's name are set aside (`ignored`, reason `link`), not deleted. One check asks "Jaina was linked to you
    as your character": "It was me" links it again and uses those records at once ("Thanks. Jaina now counts as
    yours."); "Undo it" leaves it out ("Saved. Jaina no longer counts as yours.").
  - When my id is made on a character on the guild's roster (or linked to another player) that isn't mine, a
    check asks "Your player id is made on Jaina, who isn't one of your characters", and the id doesn't change
    meanwhile. "It was me": Jaina is mine and the id stays. "Undo it": the id goes, a new one is made on a
    character of mine in the guild (with none known there: "Saved. Log in on a character of yours in this guild
    to get your own player id."), every row is made again, and my sign-ups for raids still to come go out again
    under the new id. When that anchor is also a character the repair unlinks, only this question is asked.
- **Adoption, addon**, per guild, when it becomes ready (§8):
  1. this guild's inbox `me` (`me.byG[partition]`; an inbox `me` with neither `g` nor `byG` counts for every
     guild);
  2. the id the addon keeps for the partition;
  3. `shared.pid` from before ids were per guild, when its anchor is the character logged in or on this guild's
     roster (the addon never writes `shared.pid` again);
  4. a guildmate's copy of the `ch` of one of this account's characters (a second PC), only when the id it names
     was made on a character of this account that is in this guild (a copy made up by a guildmate on one of my
     own characters looks the same: see Known limits, §12);
  5. after 90 s with none (time for guildmates' copies to arrive), a new id on the inbox `main` when that
     character is in the guild, else on the character logged in. The app reconciles at the next upload. Moving
     to another guild starts that guild's own 90 s; a wait left from the old guild does nothing.
  Until the addon has an id, it builds none of its own records (`ch`, `rc`, `gb`, `bk`, `sh`), and pid-keyed
  outbox entries wait (`wait,link`).
- **Linking.** Character C belongs to player P only if C's own `ch` names P, and C is P's anchor or the anchor's
  `ch` lists C in `alts`. Nobody can attach a character to someone else's player. A new alt joins after the next
  login on the anchor. If the anchor's `ch` disappears, apps keep the last valid links. A player id whose
  characters all name another id (two accounts merged into one player) is no longer listed as a guildmate; its
  records still show under it.
- **My own id is different.** Anyone can relay a `ch` in my anchor's name. In my app a `ch` that names my id
  links a character to me only when it is mine by the rules above, and a character of mine is never moved to
  another player. My anchor's `ch` that lists a character my app doesn't know as mine opens an author check (§5):
  "Character Thrallia lists Jaina as your character". "It was me" saves the names and links them (my other PC,
  say). "Undo it" sends nothing: nothing was linked, and my addon puts my own list back at the next login on the
  anchor.
- **A forged `ch` of the character I'm playing.** When a newer `ch` of the logged-in character arrives from
  someone else, my addon stores it, then builds mine again and sends it at once (newer, at P1), at most every
  10 s; when the relayed copy is dated ahead of the clock, it tries again 10 s later. A forged `ch` of my anchor
  sent while I play another character, or am offline, can mislead guildmates' apps until my next login on the
  anchor; my own app never takes a character from it.
- **Identity changes go out at once.** A change to the first four fields of my `ch` (pid, BattleTag, main, alts)
  is sent at once; other changes wait for the 30-minute gap (§4.3). So two accounts given one id, or a new alt,
  link at the next login on the anchor.
- BattleTag (optional, from Battle.net) and main travel in the anchor's `ch`, for display only.
- App: each pid is a `users` row with `bnet_id = 'pid:<pid>'`; my pid in the guild is the `local:me` row. The
  writer of a record whose character has no linked player yet gets a stand-in `char:<name>` user with no
  membership. Roles still come only from rank indexes through `identity.syncRanks`.

## 4. Records

### 4.1 Format

A record is one string, identical in messages, `WowGuildDB` and `shared_records`:

```
<id>^<v>^<author>^<flags>^<field 1>^<field 2>…
```

- **id** = `<type>:<key>`, at most 64 bytes. Lowercase type = member space, UPPERCASE = officer space (§5).
  Unknown types are stored and relayed under their space's rules, never shown; they live 14 days and share one
  store-wide budget (§11).
- **author** = the character that wrote this version. **flags** = empty, or `d` for a tombstone (no fields).
- **fields** are positional per type; readers ignore extra trailing fields, so later versions only append.
  Lists join items with `;` and the parts of an item with `,`.
- **Escaping.** In text fields, `~ ^ ; , # |`, bytes below 0x20 and 0x7F become `~` plus two uppercase hex
  digits (`;` → `~3B`); UTF-8 passes through, so every byte on the wire and in SavedVariables is printable. Text
  is cut to the old server's limits (title 60, notes 300, sign-up note 120, notice 500) on a UTF-8 boundary first.
- **Numbers** are base36 (`0-9a-z`), written and read by the codec's own loops: never `tostring` (fengari is
  Lua 5.3 and prints `1.0`), never `tonumber(s, 36)` (Lua 5.1 uses `strtoul`, 32-bit on Windows).
- **Id lists** (recipes, items): sorted, first value then deltas, each a self-delimiting varint in the alphabet
  `0-9A-Za-z-_` (digits 0–31 end a number, 32–63 carry five more bits): about 1.8 bytes per recipe id.
- **Keys.** random = 6 base36 characters made by the creator, so the app knows the id of a raid it just
  scheduled. item key = game item id in base36 (`d72` = 17102), else `h` + a 5-character hash of the lowercased
  name. instance key = 6-character hash of the lowercased, trimmed name. skill = skill-line id (164
  Blacksmithing, 197 Tailoring …; a constant table in the codec gives English names).

### 4.2 Versions

- **v** is 8 base36 characters, zero-padded, so string order equals numeric order. The bigger v wins the whole
  record everywhere (storage, digests, import); equal v: the bigger record string wins.
- **Normal version:** v = t × 64 + (djb2(author) mod 64); t = when the person acted, in server seconds
  (`GetServerTime()`; the app uses its clock plus the skew the addon saves). An editor whose stored copy has
  t_old ≥ t uses t_old + 1.
- **Final version** ("Final" column below): v = 2,700,000,000,000 − t × 64 + (djb2(author) mod 64). Every final
  version beats every normal one and the earliest final version wins: a stale "lock" never undoes a cancel, and
  cancel against close settles the same way on every peer.
- **djb2:** h = 5381; per byte h = (h × 33 + byte) mod 2^32. Exact in doubles, no bit operations, same in JS.

Grommash schedules Molten Core (t = 1794066000) and later closes it:

```
RD:k3f9a2^1gqwzvur^Grommash^^r^Molten Core Thursday^Molten Core^tobc40^50^14^2^Bring fire resist
RT:k3f9a2^wzltl343^Grommash^^d^tob9c0^r^4kq1zm^tobn80^Thrallia.p4m7,d72,eim;Zuljin.a8x2,eim^Varok.7tq3
```

### 4.3 Record types

| Type | Key | Writer | Fields, in order | Final | Expires | Max |
|---|---|---|---|---|---|---|
| `ch` character | name | that character | pid, BattleTag, main (`1` or empty), alts (anchor only), class, race, level, faction, ilvl, repair %, consumables `flask,elixir,potion,food,bandage`, professions `skill,rank,max;…`, pvp `rank,hk`, addon version, talent points `a,b,c,unspent`, resistances `fire,nature,frost,shadow,arcane`, unenchanted slot ids `;` | | 60 d; re-stamped at once when pid, BattleTag, main or alts change, on another real change at most every 30 min, else weekly | 400 |
| `rc` recipes | name`:`skill | that character | kind `s`/`i`/`n` (spell ids, item ids, names), count, varint ids (or `;` names) | | 60 d after the newer of itself and its `ch` | 2 KB (names 6 KB) |
| `su` sign-up + reserves | raid`:`pid | a character of pid | character, role `t`/`h`/`d`, status `y`/`t`/`n`/`b`, note, reserves (item keys), reservesAt, prev reserves, prevAt | | with the raid | 400 |
| `cr` craft request | random | a character of pid | pid, item, notes, state `o`/`x`/`d` | `x`, `d` | 30 d open; 7 d after final | 400 |
| `cl` craft claim | request`:`pid | a character of pid | state `c`/`d`/`w` (claimed, done, withdrawn), claimedAt | | with the request | 60 |
| `lp` leveling post | pid`:`character | a character of pid | character, level, zone, when, note | | 3 d | 400 |
| `ca` call to arms | random | any member | character, zone, needed, message | | 1 d | 300 |
| `dg` dungeon group | random | a character of pid (the leader) | pid, character, dungeon, startsAt, leader role `t`/`h`/`d`, level, slots tank, heal, dps (leader included), note, state `o`/`x`/`d` (open, called off, done), guests `name,role,class,level;…` (players from outside the guild the leader added) | `x`, `d` | startsAt + 1 d | 700 |
| `dj` dungeon join | group`:`pid | a character of pid | character, role `t`/`h`/`d`, status `y`/`w` (in, left), class, level, joinedAt | | with the group | 160 |
| `dc` drive hand-in | random | a character of pid | pid, drive, character, amount, note | | with the drive | 250 |
| `bq` bank request | random | a character of pid | pid, item, count, note, state `o`/`x` | `x` | 30 d | 400 |
| `gb` guild bank | tab `0`–`8` | any member who scanned | tab 0: scannedAt, money, tab names, last 25 log lines; tabs 1–8: `id,count;…` | | 30 d | 1.5 KB |
| `bk` bank character stock | name | that character, while listed in `BC` | bags and bank `id,count;…` | | 30 d | 2 KB |
| `sh` shopping list | pid | a character of pid | `name,qty,skill;…` (≤ 20) | | 30 d | 1 KB |
| `wm` war marks | pid | a character of pid; at most every 5 min | marks `map,x,y,at,kind,n;…` (≤ 30; x, y in thousandths, kind `d`/`k`), maps `id,name;…` (≤ 12) | | 30 d | 1.25 KB |
| `pr` prices | pid | a character of pid | scan day, `id,copper;…` (≤ 60 reagents and bank items) | | 14 d | 800 |
| `RD` raid or event | random | officer; never rewritten | kind `r`/`p`/`e`, title, instance, startsAt, minutes, size, srLimit, notes | | startsAt + 45 d | 600 |
| `RT` raid status | raid | officer | status `o`/`l`/`x`/`d`, lockedAt; when `d` also kind, instance key, closedAt, attendees `pid,itemKey,…;…` (reserve snapshot minus items won), no-shows `pid;…` | `x`, `d` | as `RD`; a raid close stays until folded into `LY` | 2 KB |
| `LA` loot award | random | officer | raid, instance key, item key, item name, character, pid, kind `s`/`m`/`o`/`f`, roll, bonus | | 180 d, not before folded | 300 |
| `LL` loot list | instance key | officer | instance name, bosses `;`, items `itemKey,bossIndex,name;…` (≤ 150) | | never | 8 KB |
| `LY` SR+ checkpoint | instance key | officer's app, automatically | upto, bonuses `pid,itemKey,bonus;…` | | never | 3 KB |
| `AN` notice | random | officer; any officer may delete | body | | 60 d | 600 |
| `DR` supply drive | random | officer | title, unit, goal, notes, state `o`/`c` | `c` | 60 d after closed; 180 d at most | 500 |
| `BH` bank request handled | request | officer | state `s`/`d` (sent, declined) | | with the request | 40 |
| `ST` guild bank store | `1` | officer | items `key,item,id,cost,stock;…` (≤ 25) | | never | 1.4 KB |
| `BC` bank characters | `1` | officer | names (≤ 50) | | never | 700 |
| `CFG` guild settings | `1` | Guild Master (rank 0) only | officer_rank_max, relay_rank_max (`-` = none) | | never | 40 |
| `WH` Discord webhook | `1` | officer; OFFICER channel only; in no digest; its author re-sends it once a day at login | url | | never | 300 |

Ages count from the version's t (`RD`: startsAt). "With the raid / request / drive" and "as `RD`" mean the record
expires with its parent; while the parent is unknown, 120 days after its own t. Tombstones are normal versions, so a closed
partner post can be posted again.

### 4.4 Derived state

Pure functions in `app/src/shared/sharing.js`: the same records give the same answer on every peer.

- **Raid status** = `RT` (open when there is none). One sign-up per player per raid (the `su` key).
- **Reserves that count** at a close: `reserves` if reservesAt ≤ lockedAt (or never locked), else `prev` if
  prevAt ≤ lockedAt, else none. A member's app refuses reserve changes on a raid it knows is locked and always
  writes the replaced list into `prev`.
- **Craft request:** cancelled if `cr` is `x`; done if `cr` is `d` or the claimer's `cl` is `d`; claimed by the
  active claim (`c` or `d`) with the earliest claimedAt; else open. The requester's own claim is ignored.
- **Bank request:** the earlier (by t) of the requester's `x` and an officer's `BH`; else open.
- **Drive:** total = sum of `dc`; reached at total ≥ goal (later hand-ins still count); closed when `DR` is `c`.
- **SR+ loyalty** per instance (the old `closeRaid` and `awardItem`, replayed): start from the newest `LY`, then
  apply every raid close (`RT` `d`, kind `r`) and `LA` with t > upto, in (t, author, id) order. An award sets
  (pid, item) to 0. A close adds 10 to each attendee's snapshot items and zeroes their other bonuses for the
  instance, and zeroes each no-show's bonuses for the instance. When the newest `LY` is over 14 days old, an
  officer's app writes a new one folding exactly the closes and awards older than 30 days.

## 5. Trust and permissions

The game vouches only for the direct sender. Ranks come from the receiver's own latest roster scan:
officer(n) = rank(n) is 0 or ≤ officer_rank_max; trusted(n) = officer(n) or rank(n) ≤ relay_rank_max. Both
come from `CFG` (defaults 1 and none).

**Receive rules** (addon, in this order):
1. Prefix `GuildCamp`, channel GUILD (OFFICER for `WH`), sender ≠ me. A sender missing from my roster is buffered
   for up to 30 s while the roster refreshes, then dropped.
2. **Member space** (lowercase) is accepted from any guild member, so data spreads while its author is offline.
   For `ch`, `rc` and `bk` the author must be the key's character.
3. **Officer space** (uppercase) is accepted when sender = author and officer(author) (rank 0 for `CFG`), or when
   trusted(sender): a trusted relayer checked the author when it took the record first-hand (`WH`: first-hand
   only). Members never send officer-space records and never answer for officer buckets.
4. Refused: t more than 300 s in the future, already expired, malformed, or over its type's size. Caps (§11): a
   record heard from its author is never refused for them. A relayed record over its author's caps is refused
   unless relayed records of that author older than itself can make room; one of an unknown type over the
   store-wide budget, unless older records of unknown types can; one that would take the store past its caps,
   unless records of a lower class, or older ones, can.
5. Stored with via = `<first sender>,<time>,<how>`; how = `d` direct, `t` trusted relay, `m` member relay,
   `s` seeded by the app. A newer `ch` of the character I'm playing, from someone else, is then overridden by my
   own at once (§3).

**Passing on in my name.** My addon never passes on a member-space record in my name that it didn't make or get
from my app (stored `d` or `s`). Guildmates may pass it on, never me, so a guildmate who hears a record from its
author hears the author's own. Officer records in my name come back only through trusted ranks, and only trusted
ranks may pass them on.

**Import rules** (app). The trust decision (`how`) is the addon's, because only the addon saw the sender: a
demoted officer's earlier records stay valid everywhere, and anything new from them is refused at first hand.
The app adds content rules: officer-space records relayed by a member (`m`) are refused; pid-keyed records
(`su`, `cr`, `cl`, `lp`, `dc`, `bq`, `sh`, `pr`) must come from a character linked to that pid (§3), and a new
version of a `cr`, `dc` or `bq` must keep its pid; a `cl` not from the requester; `bk` only from a character in
`BC`; reserves on the loot list and within srLimit; `WH` only in officers' apps. Failures stay in
`shared_records` as `ignored`, with a reason and an audit line. Records ignored for a reason a later record can
fix (a link, the raid, the loot list, the bank characters, my role) are tried again at every import.

**Author check.** A record authored by one of my characters (in this guild, or guildless, §3) whose version this
PC didn't make shows: "A change in your name arrived that this computer didn't make: <summary>. Passed on by
<name>." with "It was me" (closes it, nothing changes) and "Undo it" (queues my previous version again when the
one before was mine, or a tombstone). A version this PC made is one still queued or waiting in its outbox, or one
in its log of my own versions (`share_sent`): versions whose `ok` arrived, versions I answered "It was me" for,
and, at a fresh start, the records in my name it held that no open or undone check is about. The log outlives the
outbox history and a fresh start. The app asks only about records:
- that came through an addon store (they have a via);
- newer than `share_since:<guild id>`, when this PC first shared in that guild (set by the first import there,
  never moved, not even by a fresh start): older ones are from another install of mine;
- not of a type the addon builds itself (`ch`, `rc`, `gb`, `bk`, `sh`, `ca`), which my other PCs and my own game
  write too.

Records of a type this version doesn't know make **one open check per sender**, whatever their types, with a
count ("5 changes of a kind this version doesn't know"; up to 200 records in one check). "Undo it" can't send
anything for them, so it closes the whole group ("Closed. This version can't undo those changes. They go away by
themselves within 14 days."; for one record "Closed. This version can't undo that kind of change. It goes away by
itself within 14 days."); "It was me" logs every version in the group as mine. My anchor's `ch` listing
characters my app doesn't know as mine opens the check described in §3, and the repair after an update asks its
two questions the same way (§3). Nothing happens by itself, so a second PC is never fought.

**Why two spaces.** If members passed on officer records that others refuse, digests would never match and the
exchange would repeat forever; officer buckets that only trusted ranks serve make every refusal temporary. A
modified addon can fake member data (a sign-up, a guild bank snapshot), never officer data. Defences: `via`
("passed on by" in the audit log), the author check, the caps (§11), and the Guild Master removing the person.
"Who passes on officer changes" (relay_rank_max) in Guild settings trades trust for speed.

| Action | Records | Who may author | Checked by |
|---|---|---|---|
| Schedule raid or event; lock, unlock, cancel; close | `RD`, `RT` | officer | addon (rank), app |
| Award loot; edit loot list; SR+ checkpoint | `LA`, `LL`, `LY` | officer | addon (rank), app |
| Post or delete notice; start or close drive; bank request sent or declined; bank characters | `AN`, `DR`, `BH`, `BC` | officer | addon (rank), app |
| Officer ranks, relay ranks | `CFG` | Guild Master | addon (rank 0), app |
| Share the Discord webhook | `WH` | officer, OFFICER channel, first-hand only | addon; kept only by officers' apps |
| Sign up and reserve | `su` | member, for their own player | app (link, loot list, limit; the app's own routes also want a sign-up before reserves) |
| Crafting request; claim | `cr`; `cl` | member; not on their own request | app |
| Partner post, call to arms, hand-in, bank request, shopping list, prices | `lp`, `ca`, `dc`, `bq`, `sh`, `pr` | member, for their own player | app |
| Character, recipes, bank-character stock | `ch`, `rc`, `bk` | that character | addon (author = key), app (`BC`) |
| Guild bank | `gb` | any member who scanned it | none beyond member |

## 6. Wire format

Prefix `GuildCamp`. Every message is ≤ 255 bytes and starts with the protocol major `1` and a type letter. Another
major is ignored; a higher one prints once: "A guildmate has a newer Guild Camp addon. Update it from the Guild
Camp app."

| Msg | Layout | Channel | When | Bytes |
|---|---|---|---|---|
| `H` hello | `1H` minor(1) count(3) 48 digests × 4, `^`, addon version | GUILD | ready, beacon, catch-up | ≤ 210 |
| `I` inventory | `1I` bucket(2) digest(4) page(1) pages(1), then ≤ 20 × [shortId(4) v(8)] | GUILD | reply to `H` or to another `I` | ≤ 250 |
| `G` get | `1G` target `^` shortIds (4 each, ≤ 55) | GUILD | reply to `I` | ≤ 255 |
| `R` records | `1R` record, then `#` record … (whole records packed) | GUILD (OFFICER for `WH`) | push; reply to `G` or `H` | ≤ 255 |
| `M` record part | `1M` mid(2) part(1) parts(1) data (≤ 249) | GUILD | a record over 253 bytes | ≤ 255 |

- bucket(id) = djb2(id) mod 32 for member space, 32 + djb2(id) mod 16 for officer space. `WH` has no bucket.
- shortId(id) = djb2(id .. "#") mod 36^4. A `G` returns every record with that shortId.
- digest[b] = `0000` when empty, else 1 + (Σ djb2(id .. "^" .. v) mod 1,679,615): a running sum (far below
  2^53) updated on every store change, over records not expired at the start of the current server hour (§11).
- `M`: mid = per-sender counter mod 1296; parts ≤ 35 (≤ 8.7 KB); joined per (sender, mid); dropped if incomplete
  after 60 s.
- No compression or libraries: varint ids put 150 recipes in about 270 bytes, and LibDeflate would add thousands
  of lines every fengari test must load.

Examples (spaces added for reading; none are sent):

```
1H 1 122 0000 … zxbw … ^0.12.0                 hello: 1,370 records, 48 digests (bucket 37 = zxbw), addon 0.12.0
1I 11 zxbw 1 1 frwo 1gqwzvur ek9k 1gr80lc3     bucket 37 holds RD:k3f9a2 and RT:k3f9a2 (locked), page 1 of 1
1G Grommash ^ frwo ek9k                        Thrallia asks Grommash for both
1R ca:x8k2pq^1gqx36dy^Thrallia^^Thrallia^Crossroads^5^Alliance at the flight master
1M 0b 1 3 LL:4kq1zm^…                          part 1 of 3 of a loot list
```

## 7. Throttle budget

- One token bucket for the prefix: 8 tokens, +1 every 1.25 s (about 0.8 a second), under the game's burst of 10
  and 1 a second. After a login or `/reload` it starts with 2 tokens. Every constant lives in one table (§15).
- Queues: P0 `H`, `G`; P1 my new records and outbox entries (`ca` first), and my `ch` sent over a forged one (§3);
  P2 `I` and replies; P3 re-stamps and tombstones of the records the addon builds (`ch`, `rc`, `gb`, `bk`, `sh`).
  P2 + P3 hold at most 400 entries; overflow is dropped (counted in `stats.dropped`) and a later exchange fixes
  it. An inventory is one entry that becomes its pages when its turn comes, and a whole-bucket push is one entry
  that becomes the bucket's records when its turn comes, so the cap never cuts them short.
- Queued replies are checked for suppression again just before sending. Replies (P2) go one at a time, 0.25–0.75
  s apart, so a guildmate's identical reply is seen in time to drop ours, and no two peers answer in step.
- A send that returns false or a result other than success (`Enum.SendAddonMessageResult`) goes back to the
  head; sending pauses 3 s and the refill halves for 60 s.
- Nothing is sent in combat, inside an instance (`IsInInstance()`), during a loading screen, outside a guild or
  before the first roster scan. Incoming work is limited to 3 ms per frame. A sender above 90 messages a minute
  is ignored for 10 minutes.

Sizing, 40 active members (about 100 characters): 1,400 records, 250 KB, 1,100 messages in all. A new member is
complete in 8–12 minutes with two or three guildmates serving. A day away (about 100 changes) costs about 80 `I`
pages and 50 `R` messages, shared among responders: 1–3 minutes. Steady state: one beacon hello per 10 minutes
per guild, one push per change.

## 8. Sync algorithm

The engine is **ready** when the character is in a guild, the roster is scanned, it is outside instances and
loading screens, and the game gives the guild's name (it can lag a few seconds behind a login or a guild invite;
until it comes, the addon looks again every 3 s). Messages that arrive while not ready are ignored. Leaving the
guild, or turning up in another guild than the one whose store is open (even when the game never said I left),
resets the roster, the online list and the guildmates heard, so the new guild waits for its own roster.

On becoming ready (login, `/reload`, a new guild, leaving an instance or a loading screen):
1. Prune (§11); load the seed (§9); settle the player id (§3); publish this guild's outbox entries (§9); rebuild
   my `ch`, `rc`, `bk`, `gb` (when scanned) and `sh`, and push those due (§4.3). Records of mine the addon no
   longer builds get a tombstone, only with clear evidence (the rebuilt list holds this character's `ch`): this
   character's `bk` (it left the bank characters), my `sh` (the list was emptied), and its `rc` for a profession
   its `ch` no longer lists. `WH` goes again once a day when I wrote it.
2. After a login or `/reload`, in a new guild, or after more than 5 minutes inside an instance: hello after 3–15 s
   + 0.5 s per online guildmate (at most 40 s). A newcomer that heard 3 or more hellos in the last 10 s doubles
   its wait, up to 2 minutes. When the hello comes due while guildmates' exchanges are still filling my store (it
   changed through an exchange in the last 30 s), the catch-up hello goes instead.

**Another guild.** When another guild's store opens, what was queued, deferred or offered for the old guild is
dropped (its outbox entries that were in flight go again once back in that guild), the exchange state (seen
messages, repeat guards, push, answer and `G` budgets, the store caps' waits) starts over, the new guild's seed may
load, and a hello goes. With no player id there yet, the new guild waits its own 90 s for guildmates' copies of
my `ch` before making one (§3).

**Push on write.** Each new local record goes out once. Nobody rebroadcasts what they receive.

**Exchange.** I *may serve* bucket b if it is a member bucket or I am trusted. Every reply waits a random
0.5–W s (W = min(6, 1 + 0.2 × guildmates), guildmates = those heard in the last 30 min, or those online in the
roster when that is more: someone who just logged in has heard nobody yet) and is dropped if an equivalent
message was seen first: an `I` for the same bucket with the same digest in the last 60 s; a `G` with the same
shortIds in the last 60 s, whatever its target (the answer goes to everyone, and askers sort their shortIds); an
`R` carrying the same id and v, seen in the last 10 min after the request arrived or up to 5 s before it. That one
rule is the anti-storm.
- **`H` from X:** for each bucket where our digests differ and one of us may serve it: if X's is `0000` and I may
  serve, push all my records of it in random order, at most once per peer and bucket a day (after that, my `I`,
  and X asks for what it lacks); otherwise send my `I` for it (even an empty one, so X knows what to push). Each
  guildmate's hellos get answers for at most 96 buckets every 10 minutes; a hello past that budget is not
  answered.
- **Settling.** While my own store is still changing I answer hellos with no `I` (a whole-bucket push to an empty
  store still goes): while my own hello of step 2 is still to come, for 30 s after it went, and for 30 s after the
  last record an exchange brought me. A hello left unanswered for this reason schedules my catch-up hello, which
  lets us serve each other once I have settled.
- **`I`(b) from Y** (any `I`, not only replies to me, so one `I` fixes many peers): if Y's digest equals mine,
  drop my pending `I`(b). Otherwise, once all pages are in (or 3 s after the first): if Y may serve b, `G` to Y
  every shortId with a (shortId, v) pair I don't hold, unless I hold exactly one record with it and mine is
  newer; if I may serve b and Y's pages were complete, push what Y lacks or holds older. When my `I` is dropped
  because the same one went out before the hello that asked for it, it goes once more after that minute (the
  asker may have missed it).
- **`G` to me:** push the matching records I may serve. A record I already sent for the same guildmate's `G` in
  the last 2 hours counts as sent again: each guildmate gets at most 64 records sent again every 10 minutes
  (first answers are free), and one asked for again past that budget stays counted for as long as they keep
  asking within 2 hours, so asking for the store over and over never makes it go out whole again. A `G` that asks
  for something I haven't sent that guildmate yet clears my repeat guard for those buckets (it is a gap I can
  fix), but never the guard on "my bucket is empty" (below). A `G` whose records haven't all arrived 20 s later
  goes again, at most twice (while records are still arriving it waits, up to 10 minutes). **`R` / `M`:** check
  (§5), keep the bigger v, store.
- **Repeat guard:** the same `I` (bucket, my digest, their digest) goes to the same peer at most once per 2 hours.
  When that very `I` is due again right after its guard ends (within one more window), nothing changed on either
  side, so the guard doubles: 4, 8, then 16 hours. A gap nobody online can fix (a member holding officer data no
  trusted rank has) costs one `I` in the first 2 hours and fewer after. An `I` for a peer whose bucket is empty
  (their digest `0000`, when no whole-bucket push goes) is guarded 16 hours at once: they take what they lack
  from it with a `G`. When a guildmate sends the very same `I` after the hello that asked for it, it counts as
  mine too, so we don't answer the same hello again in turn; for a catch-up each of us still answers in turn. A
  catch-up (the hello differs from my store in fewer than 24 buckets, the peer holds fewer records than I do, and
  I may serve the bucket) also gets my `I` once more after 90 s, as the first may have been lost. Whoever holds
  the record nobody online can pass on holds more records, so that gap gets no such extra `I`.
- **Beacon:** every 10 ± 2 min, the online peer with the lowest djb2(name .. floor(serverTime / 600)) among peers
  heard in the last 15 min and online in my roster sends `H`. **Catch-up:** `H` again 2 min (+ up to 20 s) after
  the last exchange that changed my store, or after a record's parts never all came. A hello is skipped if a
  guildmate's hello with exactly my digests was seen in the last 5 minutes, or my own was and this is not a
  catch-up (a catch-up follows evidence that something is still missing, so my earlier hello may have been lost).

At a mass login, 20 hellos spread over 40 s or more; each bucket state answers with one `I` a minute that every
newcomer uses; each missing record goes out about once, on GUILD, to everyone online. Two newcomers that log in
at the same moment both hold back their answers while settling, so they exchange with each other through their
catch-up hellos, about 2 minutes later.

## 9. Storage

### WowGuildDB.shared (SavedVariables, written at logout or /reload)

```lua
WowGuildDB.shared = {
  v = 1,
  clock = { server = 1794066000, here = 1794065990 },     -- app skew = server - here
  guilds = { ["Forever/wow"] = {                           -- realm/guild; at most 3, least recently used dropped
    pid   = "Thrallia.p4m7",                               -- my player id in this guild (§3)
    recs  = { ["RD:k3f9a2"] = "RD:k3f9a2^1gqwzvur^Grommash^^r^Molten Core Thursday^…" },
    via   = { ["RD:k3f9a2"] = "Grommash,1794066003,d" },
    sent  = { o17 = "ok,1gr80lc3,Grommash", o18 = "wait,officer", o19 = "no,stale" },
    names = { s = { [2660] = "Rough Sharpening Stone" }, i = { [17102] = "Cloak of the Shrouded Mists" } },
    stats = { peers = 7, lastHello = 1794066010, lastExchange = 1794066030, dropped = 0, refused = 2 },
    used = 1794066000, whSent = 1794066000,                -- last opened; last daily WH re-send
  } },
  -- pid = "Thrallia.p4m7"  only in stores from before ids were per guild: read (§3), never written
}
```

The receiving addon fills `names` from game data, so names never travel: spells with `C_Spell.GetSpellName` or
`GetSpellInfo` (instant), items with `C_Item.GetItemNameByID` after `ITEM_DATA_LOAD_RESULT` (≤ 50 a minute).
`stats` also counts `failed` sends, `flood` mutes and `partsLost`.

### WowGuildInbox (Inbox.lua, written by the app any time, read at login or /reload)

```lua
WowGuildInbox = {
  -- the existing view fields (guild, raids, announcements, crafters, …) stay as they are
  me = { pid = "Thrallia.p4m7", bt = "Calvin#1234", main = "Thrallia", alts = { "Thrallia", "Zuljinne" },
         g = "Forever/wow",                                -- the guild the fields above are for (the app's current one)
         byG = {                                           -- my player id per guild (§3), at most 3
           ["Forever/wow"]    = { pid = "Thrallia.p4m7", bt = "Calvin#1234", main = "Thrallia", alts = { "Thrallia", "Zuljinne" } },
           ["Forever/Rivals"] = { pid = "Bob.k2x9", bt = "Calvin#1234", main = "Bob", alts = { "Bob" } },
         } },
  outbox = {
    { op = "o17", g = "Forever/wow", id = "RT:k3f9a2", t = 1794355200, need = "o", base = "", body = "l^tob9c0" },
    { op = "o18", g = "Forever/wow", id = "su:k3f9a2:Thrallia.p4m7", t = 1794067800,
      body = "Thrallia^h^y^late 10 min^d72;eim^to53ko^^" },
    { op = "o19", g = "Forever/wow", id = "AN:q2w8zz", t = 1794069000, need = "o", del = true },
    { op = "o20", g = "Forever/wow", id = "WH:1", t = 1794069100, need = "o", chan = "OFFICER", body = "https://discord.com/api/webhooks/…" },
  },
  seed = { "RD:k3f9a2^1gqwzvur^Grommash^^r^…" },          -- only when an account's store is empty or far behind
  seedG = "Forever/wow",                                   -- with a seed: the guild it is for
}
```

**Who I am.** `me` holds the app's current guild (`g`) at the top, and `byG` an entry for each guild of mine the
app knows: the current one first, then the others by when I last played there, up to 3. A guild without a
character known to be mine has no entry. Each entry's `alts` lists only my characters in that guild, the anchor
first (≤ 20), and `main` is my main there (else my first character, else the anchor). The addon uses the entry of
the guild it is in (§3).

**Outbox rules**
- The addon publishes each entry for the current guild that `sent` does not mark `ok` or `no`: author = the
  logged-in character, t = min(op.t, now), v as in §4.2, flag `d` for `del`. `need = "o"` (and every
  officer-space type) waits for an officer() character (`wait,officer`), `"g"` (and `CFG`) for rank 0
  (`wait,gm`); pid-keyed entries wait for a character linked to my pid in this guild (`wait,link`); entries for
  another guild wait silently. A login with waiting entries prints: "2 officer changes are waiting. Log in on an
  officer character to send them." The app also understands `wait,instance`, `wait,combat` and `wait,guild`,
  which no addon writes today (entries are only published while ready, so never inside an instance).
- **Compare-and-set.** `base` = the v the app edited (empty when there was none). For a normal edit of a record
  several people write (`RT`, `LL`, `BC`, `DR`, `LY`, `CFG`), a stored v ≠ `base` gives `no,stale`, unless the
  stored version's author is one of my characters (the one logged in, or one in this guild's `me.alts`): the app
  replaces an entry it has not heard back about and keeps the first `base`, while the game may already have sent
  that first entry. So two PCs of one player editing the same record are not caught; the bigger version wins. A
  final edit of an already final record gives `no,final`. Others: `no,expired` (past the type's expiry, or 14
  days waiting), `no,malformed` and the record check's reasons.
- `sent[op]` is written only after every part has gone to the game. When any account's SavedVariables says `ok`
  (or `no`, with its reason shown), the app drops the entry from the next inbox; the addon then forgets it. An
  entry not yet sent at logout goes next time with the same id and t.
- **Seed.** When an account's store (seen in the last 30 days) holds under half the app's live records for the
  guild (WTF wiped, new PC, reinstall), the next inbox carries them, newest first (at most 3,000 records or 400
  KB), with `seedG`; the addon loads those it lacks or holds older, with how = `s`, and only on a character of
  that guild (without `seedG`: when the inbox's `guild` is the character's guild). Officer-space records are
  seeded only if they were accepted as `d` or `t`, or are my own (`o`, rebuilt from an `ok`). `WH` is never
  seeded.

## 10. App import and export

**Import.** `importShared(db, ctx, payload.shared, { file, guildId })` runs per SavedVariables file inside
`applyPayload`'s transaction, after characters and roster (`services/sync.js`), and returns
`{ imported, ignored, acked, refused, checks, checkpoints, posts, ctas }`. Records only go into the current
guild, from its partition: the key saved in app_settings `share_g:<guild>`, else the first key that matches the
guild's realm and name (ignoring case, spaces and punctuation).
1. Save the clock skew (app_settings `server_skew`); set `share_since:<guild id>` at the first import in the
   guild (§5); settle my player id for the guild when the app has none (§3).
2. Update `share_outbox` from `sent` of every partition (ops are unique), and log each version whose `ok` arrived
   in `share_sent` (a dropped entry's too: the game had sent it); collect Discord posts for my own records when
   their `ok` arrives.
3. Save the names (`item_names`, `spell_names`), the store's statistics and its size (for the seed). For each
   record whose v beats `shared_records`, in a fixed order (`ch` first so links exist, then `CFG`, `BC`, `LL`,
   `RD`, `RT`, `LY`, `DR`, `cr` and `bq`, then the rest; within a type by t): decode, apply the import rules (§5),
   upsert, and note the rows it touches. A version this app dropped as expired, or an older one, is skipped, and
   so is a record that expires with a parent the app dropped (§11). Records ignored for a reason a later record
   fixed are tried again, up to 3 rounds.
4. A record missing from a store is not a deletion; only tombstones delete. The app keeps its own history.
5. Make the rows of everything touched, once each (`share/project.js`), and sync roles when a `ch` or `CFG`
   changed. Notify (`ctx.emit`) for valid records under 24 hours old that are not mine and not from before the
   guild's last fresh start (`share_reset:<guild id>`; they were shown then): raid scheduled or cancelled, notice,
   call to arms under 1 hour old, a request I can craft, claims and deliveries of my request, bank request
   (officers), an answer to my bank request, drive started or reached. Officer records add an audit line:
   "Grommash cancelled Molten Core (passed on by Thrallia)." An officer's app writes the SR+ checkpoint (§4.4).
   At most once per server hour, the records every addon has expired leave the app's copy (§11). Outbox history
   older than 30 days is deleted.

**Discord posts.** Each app posts only what its own player did, once the game confirmed it (`ok`): a new raid or
event, a cancel, a new loot award, notice, call to arms, crafting request, bank request or drive. A drive's goal
("🎉 **<title>** reached its goal of <goal> <unit>. Thanks everyone!") is posted once, by the app of the player
whose hand-in first brought the total to the goal (hand-ins in the order they were made), checked when the upload
with that hand-in's `ok` is in, guildmates' hand-ins from the same upload included; a closed drive gets none. A
call to arms written in game with `/wow cta` is posted when it first arrives here, under an hour old, from one of
my characters, and not from before a fresh start.

Migration 15 adds `share_id TEXT` (unique per guild) to raids, loot_log, craft_requests, buddy_posts, ctas,
announcements, drives, drive_contribs and bank_requests; `raids.locked_at`; `signups.reserves_at`;
`loot_items.item_key`; `guilds.relay_rank_max`; and four tables. Migration 16 adds `characters.game_guild` (the
in-game guild an upload of this computer gave for the character, §3) and `share_author_checks.names`. Migration 17
adds `share_sent` (filled from the outbox's sent versions and from checks answered "It was me") and
`share_pruned`, adds `kind`, `n` and `recs` to `share_author_checks`, and copies the one `share_since` to
`share_since:<guild id>` of every guild with shared records, then deletes it.

```
shared_records      (guild_id, id, v, author, via, how, body, state 'ok'|'ignored', reason, kept, first_seen,
                     PRIMARY KEY (guild_id, id))      kept = the last 'ok' version, shown while a newer one is ignored
share_outbox        (op PRIMARY KEY, guild_id, rec_id, t, base, need, chan, del, body, record,
                     state 'queued'|'sent'|'waiting'|'refused'|'dropped', note, sent_v, sent_author, created_at, sent_at)
                                                      record = the provisional record the rows show meanwhile;
                                                      dropped = replaced or cancelled here, kept so a late ok is known
share_author_checks (id, guild_id, rec_id, v, prev, via, summary, names, state 'open'|'mine'|'undone', created_at,
                     kind, n, recs, UNIQUE (guild_id, rec_id, v))
                                                      names = the characters a ch or repair check is about (JSON);
                                                      kind = NULL | 'unknown' | 'pid' | 'repair'; n = how many records;
                                                      recs = [[id, v], …] of a grouped 'unknown' check (JSON)
share_sent          (guild_id, rec_id, v, at, PRIMARY KEY (guild_id, rec_id, v))
                                                      my own versions (§5); kept through a fresh start
share_pruned        (guild_id, id, v, at, PRIMARY KEY (guild_id, id))
                                                      records dropped as expired, with their last version (§11)
spell_names         (spell_id INTEGER PRIMARY KEY, name TEXT NOT NULL)
```

App settings for sharing: `server_skew`, `share_since:<guild>` (when this PC first shared there, §5),
`share_g:<guild>`, `share_stats:<guild>`, `share_stores:<guild>` (each account store's size, for the seed),
`share_reset:<guild>` (the last fresh start), `share_pruned_at:<guild>` (the hour of the last pruning),
`me_pid:<guild>` (my player id; `me_pid` from before ids were per guild), `share_my_alts:<guild>` (characters I
confirmed with "It was me"), `share_repair` (the repair after the update ran, §3), `me_battletag`,
`shared_webhook`, `share_op_seq` and `share_pr_day`.

| Records | Tables |
|---|---|
| `ch` | users (`pid:<pid>`, battletag), memberships (role from rank via syncRanks), characters (user_id by the §3 links, class, race, level, faction, readiness, extras, is_main), professions. A character of mine keeps what my uploads wrote. |
| `rc` | recipes, replaced per character and profession; name from spell_names or item_names, else "Recipe 12345" |
| `RD` + `RT` | raids (status, locked_at), attendance (from the close) |
| `su` | signups (reserves_at), reserves (item key → loot_items) |
| `LL` | loot_items, replaced per instance (item_key, item_id). With no list record (my first list cancelled or refused) the rows it made go; rows typed before sharing stay as typed, and get their key once the guild has the list. |
| `LA` | loot_log; made again when its raid or its loot list rows arrive or change, so the arrival order doesn't matter |
| `LY` + closes + `LA` | loyalty, rebuilt per instance by the fold |
| `cr` + `cl` | craft_requests (status and crafter_id derived) |
| `lp`, `ca`, `AN` | buddy_posts, ctas (client_ref = key), announcements |
| `dg` + `dj` | no rows: routes/dungeons.js reads the effective records and the line-up comes from `dungeonGroupState` (the leader fills a slot of their role; then the leader's guests in the order listed; then joins in joinedAt order, a tie to the smaller pid; past a role's free slots they wait). A `dj` on the leader's own group is ignored (`own group`). |
| `DR` + `dc` | drives (status derived), drive_contribs |
| `bq` + `BH` | bank_requests (status and handled_by derived); with no record at all (my new request cancelled or refused) the row goes |
| `gb` | guild_bank, bank_log, guilds.bank_money and bank_scanned_at |
| `BC`, `bk` | characters.is_bank (no record: no bank characters); inventory of bank characters |
| `sh`, `pr` | shopping_lists; prices (the lower price kept for the same item and day) |
| `wm` | war_marks, replaced per player (mine too), and war_maps (map names); see [api/war.md](api/war.md) |
| `ST` | store_items, replaced as a whole; orders are `bq` requests whose note starts `[store:<key>:<cost>]` ([api/seasons.md](api/seasons.md)) |
| `CFG` | guilds.officer_rank_max and relay_rank_max (no record: the defaults, 1 and none), then identity.syncRanks |
| `WH` | app_settings `shared_webhook`, officers only; Settings offers "Grommash shared a Discord webhook. Use it?" |

Instance names match by the instance key's rule everywhere (ignoring case and surrounding blanks), so a raid typed
"molten core" shows the "Molten Core" list, and a new raid takes the list's spelling. A record the app dropped as
expired (§11) leaves its rows as they were: a past raid, an old notice or a player's name (when the anchor's `ch`
went) stay as history.

**Export.** Routes write no rows themselves. Each core route that changes shared data checks input and role as
today, then calls `sharing.queue(db, ctx, { type, key, fields, del, need, base, chan })`. That signs a provisional
record with my author in the guild (my main, else my most recently played character there), t = now + skew
(t_old + 1 when needed), writes the `share_outbox` entry with it (state `queued`), and makes the rows of what it
touches at once (`share/project.js`). Rows always show the **effective** record of an id: the bigger of the stored
record (the `ok` one, or `kept`) and this computer's provisional records still `queued` or `waiting`. A new entry
for a record already queued replaces it (the old one becomes `dropped`) and keeps the first `base`. The core's
emitter sends `outbox`, and `main/sync.js` rewrites the inbox about 1 s later (`exportOutbox` → `outbox`,
`exportMe` → `me`, `exportSeed` → `seed` and `seedG`). The record coming back through an addon store has the same
id, so nothing is duplicated. A newer version from someone else replaces our row and refuses our pending entry
(the "already closed or cancelled" line when that version is final, else the "changed in the meantime" line). A
refused or cancelled entry just makes the rows again without it: a new bank request disappears, a first loot
list takes the items it made, a first `BC` or `CFG` goes back to the defaults. Rolls stay on the officer's PC; the
result travels in `LA`.

| App action | Records queued |
|---|---|
| Schedule raid or event | `RD` |
| Lock / unlock / cancel / close | `RT` `l` / `RT` `o` / `RT` `x` / `RT` `d` with snapshot and no-shows |
| Award loot; SR+ checkpoint (officers' apps, automatic) | `LA`; `LY` |
| Sign up or reserve (reserves need a sign-up; refused when locked) | `su` |
| Edit loot list; post or delete notice | `LL`; `AN` or its tombstone |
| Request, cancel, mark done; claim, done, withdraw as crafter | `cr`; `cl` |
| Partner post or close; call to arms | `lp` or its tombstone; `ca` |
| Start or close drive; hand-in | `DR`; `dc` |
| Bank request or cancel; sent or declined | `bq`; `BH` |
| Bank characters; officer and relay ranks (Guild Master; "Off" for officers is saved as 0, the Guild Master alone, since `CFG` can't carry "none" there); share webhook | `BC`; `CFG`; `WH` |
| Prices (once a day, from Auctionator) | `pr` |
| "Undo it" on an author check | my previous version, or a tombstone |
| Main, BattleTag, alts, pid; "It was me" on a `ch` check | inbox `me`; the addon rewrites `ch` |

The addon builds `ch`, `rc`, `gb`, `bk` and `sh` itself. `/wow cta` writes a `ca` and sends it at once:
guildmates online get a chat line and a sound, and `ctaQueue` goes away.

## 11. Pruning and bounds

- Expiry comes from each record's own fields and server time (§4.3), evaluated at the start of the current
  server hour, so every peer drops the same records in the same hour. Pruning runs on becoming ready, at each
  hour boundary (+ 0–30 s) and at logout. Expired records leave the digests and are refused.
- Tombstones keep their type's expiry (180 days for types that never expire). Raid closes and `LA` stay until an
  `LY` covers them (t ≤ upto), whatever their expiry. Records of types this version doesn't know expire 14 days
  after their t.
- **Author caps**, member space, types this version knows: at most 300 records and 64 KB per author, plus 32 KB of
  `rc`. Anyone may pass on a member record in anyone's name, so the author field is no proof, but a record heard
  from its author is:
  - A record heard from its author (how `d`) is never refused for caps. Room comes first from that author's
    records stored as relays, those of the guildmate who passed on the most of them first, oldest first, and
    only then from the author's own oldest records.
  - A relayed record over the caps may push out only relayed records of that author older than itself, else it is
    refused. Stores only move to newer records, so an exchange can't go round in circles.
  - My own new records make room the same way, so my store keeps my caps too.
- **Unknown types** don't count toward author caps (anyone may write them in anyone's name). They share one
  store-wide budget of 200 records and 32 KB, checked on receive and again at each prune: the oldest go, a relayed
  one only pushes out older ones (else it is refused), and one heard from its author always gets in.
- **Store caps**, far above normal: 4,000 records and 600 KB per guild. They hold when a record is stored: one that
  would take the store past a cap makes room first, or is refused. Records go by class, lowest first:
  1. records of types this version doesn't know;
  2. member records whose author is not on my roster (once the roster is scanned: made-up names, or players who
     left);
  3. member records a guildmate passed on, grouped by who passed them on: the guildmate who passed on the most
     goes first, oldest first;
  4. records from my app's seed;
  5. sign-ups of past raids;
  6. guild bank tabs;
  7. loot awards folded into an SR+ checkpoint;
  8. a member's `ch` and `bk`, and a price list keyed by its author's own player id, when passed on or seeded
     (grouped as in 3): nobody can make more of them in a member's name;
  9. price lists heard from their author.

  Never pushed out: officer records (except folded `LA`), and member records heard from their author or mine,
  except those in classes 5, 6 and 9 (my own price list never goes).
  - A relayed record may push out only records of a lower class, or of its own class that come before it in that
    order and are older than itself. A relayed `ch`, `bk` or price list never pushes out a `ch`, `bk` or price
    list that another guildmate passed on or my seed brought. Else it is refused.
  - A record heard from its author, my own, and my app's seed always get in. (A seed is checked by one pass after
    it loads.)
  - One pass goes down to 40 records and 6 KB below the caps, so a flood doesn't start a pass for every record.
  - When a pass for a relayed record can't get that far, what that guildmate passes on over the caps is refused
    without a pass for 1 minute (only theirs). When even a record heard from its author finds too little to push
    out, every relayed record over the caps is refused, without a pass, for that minute. So a store full of
    records it may not push out costs a pass a minute per guildmate passing records on, not a pass per record.
- **The app's copy.** At most once per server hour, from an upload, the app drops the records every addon has
  expired by the same rules (`share/prune.js`): only when the version the rows show has expired too, never one
  with a change of mine still to send. The rows they made stay as history (`share_pruned` keeps the id and last
  version), an expired copy that comes back is refused, and so is a record that expires with a dropped parent
  (except a raid close no `LY` covers yet, which no addon expires). A newer version that is used brings the id
  back.
- A guild bank tab is published only when it changed and the stored copy is over 15 minutes old, or it is over
  7 days old; tab 0 at most every 2 hours.

## 12. Failure cases

| Case | What happens |
|---|---|
| Lost message or part | Incomplete record dropped; the next exchange fixes it (a `G` goes again after 20 s; a lost part brings a catch-up hello). |
| Guildmate logs off or enters an instance mid-transfer | Others serve the rest at the next hello or beacon. |
| Throttle | Our bucket stays under it; a refused send goes back to the head after a pause. |
| Combat, instance, loading screen | Sending pauses; messages in instances are ignored; hello after leaving. |
| Game crash (no SavedVariables written) | That session's received records and acknowledgements are lost; outbox entries go again with the same id and t. Guildmates' exchanges and my own inventories catch me up again (a newcomer whose game crashes twice: Known limits, below). |
| WTF folder wiped, new PC, reinstall | The app seeds the store; the pid comes from the inbox, else from this account's characters' `ch` (§3). |
| App database lost | Rebuilt from the addon stores at the next upload; history older than the stores is gone. |
| Fresh start (Guild Master, Officer tools) | The same path, on purpose. This PC's shared records, answered author checks, sharing statistics and outbox history go; unsent changes (`queued`, `waiting`) and unanswered author checks stay, and their rows are made again at once. First the records in my name it holds, with no open or undone check about them, go into the log of my own versions (`share_sent`). The next upload brings every record back from the addon's store, whatever its age (`freshOnly` leaves `shared` alone). My own records coming back are not flagged (the log), a forged one from before the fresh start still is (`share_since` doesn't move), records from before it don't notify again, and a call to arms from before it is not posted to Discord again (`share_reset:<guild id>`). Player ids, confirmed characters and guildmates' games don't change. |
| Officer demoted or left | Records accepted earlier stay valid; new ones are refused at first hand. |
| Sender's rank unknown | Buffered 30 s, then dropped; served again later. |
| Guild name late after login or an invite | Not ready until the game gives it; looked for every 3 s; the login hello goes then. |
| Moved to another guild (with or without the game saying I left) | The roster starts over; the new guild's store opens with a hello; nothing queued for the old guild goes there, and its outbox entries go once back in it. With no player id there yet, the new guild waits its own 90 s for guildmates' copies of my `ch`. |
| Stale edit from the app | `no,stale`; the app rolls back and says so. |
| Forged member record | Stored with via; the author's app flags it; "Undo it" re-sends the real version. The author's own addon never passes it on (§5). |
| Forged `ch` of my anchor | My app links nobody to me from it and asks (§3); my addon overrides it at once while I play that character, else at my next login on it. |
| Flood of records in someone's name | Their real records still get in wherever they are heard first-hand (§11); unknown types keep to their budget. The store never goes past its caps for relayed records: what one guildmate passed on goes first; price lists, `ch` and `bk` go last, never for what another guildmate passed on; officer records and records heard from their author stay, except sign-ups of past raids and guild bank tabs. A store stuck at its caps refuses that guildmate's records for a minute at a time, not the guild's. |
| Made-up hellos (all zeros, random digests) | A whole bucket goes to a peer at most once a day; at most 96 buckets answered per peer every 10 minutes; the same hello again costs about one or two messages (the repeat guard counts a guildmate's identical `I`, and doubles up to 16 hours). Some variants still cost more (Known limits, below). |
| `G` for the whole store, again and again | The first answer is whole; after that at most 64 records sent again per 10 minutes to that guildmate, for as long as they keep asking. |
| Database from an older version | Once, at core start: characters it linked to me through a guildmate's `ch` are unlinked and asked about; a player id made on a guildmate's character is asked about, never changed by itself (§3). |
| Alt in another guild | Separate partition with its own player id, made on a character of that guild (§3); that guild's entries wait for a character of it. |
| Addon updated while the game runs | The app installs and updates the addon itself only while the game is closed; one the player starts says when only a game restart loads it (a new folder, or a `.toc` listing other files). In game, `/wow share` and `/wow cta` say to restart when the sharing files didn't load (§2). |
| Wrong PC clock | App times corrected with the saved skew; the addon clamps t to `GetServerTime()`. |
| Garbage or hostile input | Handlers in pcall; oversized or broken messages dropped; flood guard; caps. |
| Newer protocol, unknown type | Other major ignored with an update line; unknown types kept and relayed within their budget, for 14 days. |
| Recipe window without ids | Spell id from `GetTradeSkillRecipeLink` / `GetCraftRecipeLink` (`enchant:(%d+)`), else the crafted item id (`item:(%d+)`), else names (kind `n`). |
| Digest collision (4 characters) | Very rare; the bucket syncs at its next change. |

### Known limits

What the code still can't do without a server. None of these lets a guildmate merge me with another player or
fake officer data.

**Sharing in game (addon)**
- A newcomer whose game crashes before saving twice in a row starts the third login with an empty store again.
  Guildmates already pushed each bucket to them that day, and an empty store sends no inventory of its own, so
  that login can take hours to fill (up to about 16 in tests). A game that saves once catches up as usual, and the
  app's seed (§9) still fills a store it knows is behind.
- Some made-up hellos still cost the guild an inventory round, roughly 50 to 180 messages, every 10 minutes: fresh
  made-up digests each time, a hello shaped like a catch-up (made-up digests in fewer than 24 buckets, repeated),
  and a fixed made-up hello followed by a `G` for one new record of every bucket. Only the answer budget (96
  buckets per guildmate every 10 minutes) bounds them. The all-zero hello costs one inventory round every 16
  hours and one whole-store push a day.
- The `G` budget is kept by each responder: a guildmate who asks each responder in turn gets the whole store once
  from each, then up to 64 records per 10 minutes from each.
- Store caps group records by count, not size: made-up `bk`, `ch` or price lists, one per roster character, are
  class 8 and push out what honest guildmates passed on (class 3) before their own. Price lists, `ch` and `bk`
  that others passed on, and officer records, still stay.
- Forged records that reached me through an honest guildmate count as that guildmate's: over the caps, their oldest
  records go first, older real records among them.
- While a store is stuck at its caps, a guildmate whose records can't get in is refused a minute at a time; those
  records come back through a later exchange.
- Records heard from their author, mine and seeded ones still get in when nothing may go, so they can take a store
  past its caps, by at most the real senders × 300 records.
- A guildmate can make up a player id on one of my own characters and pass on my `ch` naming it before my first
  login here with a fresh addon. The addon can't tell that copy from my other PC's (both reach it passed on), so it
  adopts it (§3, step 4). The anchor is mine and my own `ch` lists only my characters, so it can't link me to
  another player, and when the app already has an id for the guild, the inbox `me` wins at once.

**Who I am (app)**
- With no id of the addon's own for the guild yet, or with an id made up on a Battle.net-only character of mine, a
  guildmate can still pick my player id at my first upload in the same way (§3, adoption step 1).
- The other side of that step: two PCs that play the same character and each made their own id before seeing the
  other's keep separate ids. The addon's 90-second wait for a guildmate's copy is what normally joins them.
- A record forged in my name dated before this PC first shared in the guild (`share_since:<guild id>`) is taken
  without a question: it looks like my own record from an earlier install.
- An answered group of unknown-type records doesn't survive a fresh start: its records under 14 days old are asked
  about again as a new group.
- "Undo it" on "Your player id is made on Jaina…" sends again only my sign-ups for raids still to come. Older
  records made under the old id keep showing under that id's player.
- A guildless character of mine still shows on the guild's roster, among my alts on a character page and in the
  sign-up pickers. The crafters list still counts the recipes of my characters in another game guild.
- Hiding characters of another game guild compares guild names ignoring case for ASCII letters only: a name that
  differs only in the case of an accented letter can count as another guild on those pages.

**The app's copy**
- A raid close that arrives after its raid was dropped as expired (45 days or more after the start) counts for
  SR+, but the past raid's row stays open with no attendance.
- `share_pruned` keeps one row for each dropped record that made rows, for good, short-lived calls to arms and
  partner posts included.
- A fresh start makes the raids' rows again, so a raid starting within the hour gets its "starts in an hour"
  notification a second time (and my Discord post, when I scheduled it).
- The drive-goal post (§10) is best effort: when my hand-in's `ok` arrives before the `ok` of a drive I started,
  nothing is posted, and a guildmate's earlier hand-in arriving in a later upload can change after the fact who
  reached the goal.

**Restart wording (app)**
- Whether a `/reload` loads a new addon folder or new `.toc` entries isn't checked in the real game yet (§15). All
  restart wording rests on it.
- The wait for a game restart ends only once none of the game processes running when the folder was made is
  left, and the process list doesn't say which game folder a process belongs to. So with Classic Era still
  running, a fresh start of WoW Forever keeps the restart wording. When Guild Camp can't read the process ids,
  only a game seen closed ends the wait; when it can't tell at all whether the game runs, the wait never ends by
  itself, and automatic addon installs and updates don't run on that PC.
- A game folder whose addon was removed while it waited stays in the Sync card's notice until the game is seen
  closed.
- On a group of unknown-type records the second button still says "Undo it", though it can only close the check.

## 13. Test plan

**Harness.** `wowsim.js` lives in `app/test/sim/` (moved from the old server tests).
- wowsim gains an optional virtual clock (`C_Timer`, `GetTime`, `GetServerTime`, `time`), configurable
  `UnitName` and roster, `C_ChatInfo` messaging, `IsInInstance`, and name mocks. Existing tests keep immediate
  timers.
- **GuildNet** (`app/test/sim/guildnet.js`): `net.client(name, { rank, account, savedVariables, inbox })`,
  `login/logout/reload/crash`, `setInstance`, `setCombat`, `run(seconds)`; seeded randomness, latency, loss and
  reordering. GUILD reaches every online client including the sender; OFFICER only ranks that can read it. It
  applies the game's throttle (burst 10, then 1 a second per sender and prefix; extras silently dropped and
  counted); over 255 bytes, a NUL byte or an unregistered prefix fails the test. `net.stats()`, `net.digests()`,
  `net.converged()`.
- **Unit.** JS and Lua codecs give identical bytes on golden vectors (records, escaping, varints, hashes,
  buckets, digests, both version bands); fuzzed parsers never throw; one table of accept and refuse cases runs
  against addon and core. Lua 5.1 guard: luaparse with `luaVersion: '5.1'` plus a scan for `//`, `goto`, bit
  operators, `utf8.`, `string.pack`, `math.type` and `tonumber(…, 36)`; floats such as 1.0 fed to the codec; a
  real `lua5.1` run of the codec in CI when available; SavedVariables round trip of every escape.

Every scenario ends by asserting equal digests on all clients and, by running the real core on each client's
SavedVariables, equal domain tables.

| # | Scenario | Pass when |
|---|---|---|
| 1 | A sends a call to arms | In B's chat within 2 s and in B's store |
| 2 | A signs up and logs off; B online; C logs in | C has the sign-up (how `m`) |
| 3 | Officer schedules and logs off; only members online; C logs in | C gets the raid once an officer or relay rank is online |
| 4 | Patched client fakes `RT`, `LA`, `CFG` first-hand and relayed, and fakes a member's `su` | Officer fakes refused everywhere; `su` stored with via; author's app flags it; "Undo it" restores |
| 5 | Cancel, close and lock by three officers, every delivery order | Same status everywhere (earliest final) |
| 6 | Awards, closes and a checkpoint in every order, awards arriving after the close | Same loyalty as the old server's raid tests (fixtures from `server/test/raids.test.js`) |
| 7 | 25 clients, a simulated week of random play, 10% loss | Converged after a final hour all online; zero throttle drops; rate within budget |
| 8 | 20 logins in 60 s, 1,400 records, 30 differ | Messages ≤ 1.5 × needed + hellos, where needed = one exchange (the differing buckets' `I` pages, one `G` per bucket, the `R` / `M` messages for the 30 records) × ceil((span + 40) / 60) one-minute rounds (logins spread over span seconds, plus a hello wait of up to 40 s) |
| 9 | New member, 3 online, 1,400 records | Complete within 15 virtual minutes |
| 10 | Instance and combat | Nothing sent inside; hello after |
| 11 | Officer demoted between create and relay | Old records spread; new ones refused |
| 12 | Expiry, caps, tombstones; a peer back after 60 days | Store bounded; nothing comes back |
| 13 | App → inbox → addon → GuildNet → addon → SavedVariables → other app, with the real `sync.js` and core | Entry sent, acknowledged and dropped; officer entry waits for an officer character; stale edit refused and rolled back; two accounts merge; wiped WTF seeded with no bulk traffic |

Where they run: `app/test/sim/share-scenarios.test.js`, `share-scale.test.js` (7, 8, 9; the full sizes with
`GUILDCAMP_SIM_HEAVY=1`), `share-engine.test.js`, and `e2e-share.test.js` (13, and 5 and 6 through real apps).
`share-identity.test.js` and `app/test/core/sharing-identity.test.js` cover §3 (forged `ch`, adoption, ids per
guild, guildless characters); `share-robustness.test.js` and `app/test/core/sharing-unknown.test.js` cover
floods, store caps, made-up hellos, `G` floods, the late guild name and guild switches. In `app/test/core/`,
`sharing-author.test.js` covers author checks (`share_since` per guild, the log of my own versions, fresh starts,
adoption when the addon has its own id), `sharing-prune.test.js` the app's pruning, and `sharing-repair.test.js`
the repair after an update.

## 14. Implementation steps

All steps are done; the "Done when" tests run in the default suite.

| Step | Work | Done when |
|---|---|---|
| 1 | `app/src/shared/sharing.js` and `ShareCodec.lua`: types, encode and decode, escaping, base36, varints, djb2, buckets, digests, versions, expiry, accept rules; derived state in JS | Golden vectors, fuzz and the 5.1 guard pass |
| 2 | wowsim virtual clock and messaging; GuildNet | Existing addon tests unchanged |
| 3 | `Share.lua`: store, outbox and acknowledgements, push on write, receive and checks, packing and parts, queues and token bucket, `/wow share` ("Sharing with 7 guildmates. 1,368 records. 1 change waiting.") | Scenarios 1, 2, 4, 10 |
| 4 | `Collect.lua`: `ch` (pid, alts), `rc` with ids, `gb` per tab, `bk`, `sh`; names; live `ca` | Unit tests, scenario 1 |
| 5 | `ShareSync.lua`: `H`/`I`/`G`, suppression, beacon, pruning | Scenarios 3, 7, 8, 9, 11, 12 |
| 6 | Core: migrations 15 to 17, `importShared`, `exportOutbox`, `exportMe`, `exportSeed`, `queue`, handlers, derived state, loyalty fold and `LY` writer, route exports, notifications, audit, author check, pruning, the repair after an update | Scenarios 5, 6, 13 |
| 7 | App UI: waiting and refused changes on Addon & sync, sharing status, webhook offer, "Who passes on officer changes" in Guild settings | Renderer tests |
| 8 | Update docs/ARCHITECTURE.md; move server tests to `app/test/core`; delete `server/` | Full suite passes |

## 15. Check in game before tuning

- The throttle on WoW: Forever (burst, refill, per prefix or per client, return codes). Every number above is a
  constant in one table.
- Whether addon messages are blocked beyond instances (open-world combat, battlegrounds).
- Recipe ids on interface 16001 (`GetTradeSkillRecipeLink`, `GetTradeSkillItemLink`). Without them `rc` falls
  back to names and grows about ten times.
- SavedVariables load time with a full 600 KB store.
- Whether a `/reload` loads files newly listed in a `.toc`, or a brand-new addon folder. The app assumes it doesn't
  and asks for a game restart (§2, §12).

## 16. Design record

Base: the panel's simple design. Grafted from the bandwidth design: packed records, varint ids, per-tab guild
bank, seeding, the SR+ fold. From the trust design: unfakeable player links, printable escaping, beacon, wave
backoff, UI lines. New: final-band versions, compare-and-set. Left out: signatures and rank timelines (too heavy
for v1), per-author sequence numbers (forgeable, break across PCs), whispers, a second prefix (unverified).
After review (2026-11-08): player ids per guild and only this computer's evidence for what is mine; caps that
never refuse what is heard from its author, and a separate budget for unknown types; per-peer push and answer
budgets against made-up hellos; readiness that waits for the guild's name. After the second review (2026-11-08):
store caps that hold when a record is stored, by class; repeat guards that double and a `G` budget; guildless
characters that count as mine but never decide who I am; `share_since` per guild and a log of my own versions;
one author check per sender for unknown types; pruning in the app; a one-time repair of who I am. What is still
open is under Known limits (§12).

## Appendix A. Field names

The codec (`app/src/shared/sharing.js` `TYPES`, mirrored in `addon/WowGuild/ShareCodec.lua`) names every
positional field. Decoded records look like
`{ id, type, key, v, t, author, del, fields: { <name>: value } }` (unknown types keep `raw` instead of `fields`).
Golden vectors: `app/test/fixtures/sharing-vectors.json`.

**Field kinds.** `text(n)`: escaped, cut to n bytes on a UTF-8 boundary first. `int`: base36, empty = none
(`int-` writes none as `-`). `enum "abc"`: one of those characters, or empty. `flag`: `1` or empty. `ids`:
varint id list. `[x]`: a list (items joined with `;`); `(a, b)`: an item or tuple of parts joined with `,`;
`(a, b…)`: a variable number of trailing parts.

**Writing rules.** Trailing empty fields, trailing empty parts and empty list items are left out (so
`RT` `l` is `l^tob9c0`). Lists are cut to their item limit. When a record would be over its type's size, the
longest escaped text field (ties: the later one) is cut by the overflow, on an escape and UTF-8 boundary, until it
fits; lists are never cut for size, so a record with too many items is refused by the size check. Varints are
written most significant group first. Item keys and instance keys hash the trimmed, ASCII-lowercased name with
djb2 (`h` + 5 base36 characters mod 36^5; instance: 6 characters mod 36^6). A random key is 6 base36
characters.

**Reading rules.** Missing trailing fields and parts read as empty; extra ones are ignored. A record is
malformed when: a byte is below 0x20, 0x7F, `#` or `|`; it has fewer than 4 parts; the type is not 1–4 letters
of one case; the key is empty, holds a space, `~`, `;` or `,`, or does not match its type's key segments; v is
not 8 base36 characters; v mod 64 ≠ djb2(author) mod 64 (the author slot, true in both bands); the author is not
1–48 bytes without `~ ^ ; , # | : .`, space or controls; flags are not empty or `d`; a tombstone has fields; an
escape is not `~` + two uppercase hex digits of a byte that must be escaped; a raw `~ ^ ; , # |` sits in a text
field; a number is not base36 (at most 10 characters); an enum or flag has another value; a varint is cut off;
or (known types) a final-band v sits on a state that is not final, or a final state has a normal v.

**Key segments** (split on `:`): name (a character, 1–48 bytes, no `.`), random (6 base36), int (base36),
pid (`<name>.<4 base36>`), tab (`0`–`8`), `1`.

| Type | Key | Fields |
|---|---|---|
| `ch` | name | pid text(64), battletag text(32), main flag, alts [text(48)] ≤ 20, class text(20), race text(20), level int, faction text(12), ilvl int, repair int, consumables (flask, elixir, potion, food, bandage: int), professions [(skill, rank, max: int)] ≤ 12, pvp (rank, hk: int), addon text(16), talents (a, b, c, unspent: int), resists (fire, nature, frost, shadow, arcane: int), unenchanted [int] ≤ 10 (slot ids of chest 5, feet 8, wrist 9, hands 10, back 15, main hand 16) |
| `rc` | name:int (skill-line id) | kind enum `sin`, count int, list: kind `n` → [text(100)] ≤ 500, else ids ≤ 2000 |
| `su` | random:pid | character text(48), role enum `thd`, status enum `ytnb`, note text(120), reserves [text(12)] ≤ 10, reservesAt int, prev [text(12)] ≤ 10, prevAt int |
| `cr` | random | pid text(64), item text(100), notes text(200), state enum `oxd` |
| `cl` | random:pid | state enum `cdw`, claimedAt int |
| `lp` | pid:name | character text(48), level int, zone text(60), when text(60), note text(140) |
| `ca` | random | character text(48), zone text(60), needed int, message text(200) |
| `dg` | random | pid text(64), character text(48), dungeon text(60), startsAt int, role enum `thd`, level int, tank int, heal int, dps int, note text(140), state enum `oxd`, guests [(name text(48), role text(1), class text(20), level int)] ≤ 9 |
| `dj` | random:pid | character text(48), role enum `thd`, status enum `yw`, class text(20), level int, joinedAt int |
| `dc` | random | pid text(64), drive text(8) (the `DR` key), character text(48), amount int, note text(120) |
| `bq` | random | pid text(64), item text(100), count int, note text(200), state enum `ox` |
| `gb` | tab `0` | scannedAt int, money int, tabs [text(32)] ≤ 8, log [(at int, kind text(12), who text(48), item int, count int, amount int)] ≤ 25 |
| `gb` | tab `1`–`8` | items [(id, count: int)] ≤ 98 |
| `bk` | name | bags [(id, count: int)] ≤ 200, bank [(id, count: int)] ≤ 300 |
| `sh` | pid | items [(name text(100), qty int, skill int)] ≤ 20 |
| `wm` | pid | marks [(map int, x int, y int, at int, kind text(1), n int)] ≤ 30, maps [(id int, name text(40))] ≤ 12 |
| `ST` | one | items [(key text(6), item text(60), id int, cost int, stock int)] ≤ 25 |
| `pr` | pid | day int, prices [(id, copper: int)] ≤ 60 |
| `RD` | random | kind enum `rpe`, title text(60), instance text(60), startsAt int, minutes int, size int, srLimit int, notes text(300) |
| `RT` | random (the raid) | status enum `olxd`, lockedAt int, kind enum `rpe`, instance text(8) (instance key), closedAt int, attendees [(pid text(64), items text(12)…)] ≤ 60 (≤ 20 items each), noShows [text(64)] ≤ 60 |
| `LA` | random | raid text(8), instance text(8), item text(12) (item key), itemName text(100), character text(48), pid text(64), kind enum `smof`, roll int, bonus int |
| `LL` | random (instance key) | name text(60), bosses [text(60)] ≤ 40, items [(item text(12), boss int (1-based index, 0 = none), name text(100))] ≤ 150 |
| `LY` | random (instance key) | upto int, bonuses [(pid text(64), item text(12), bonus int)] ≤ 200 |
| `AN` | random | body text(500) |
| `DR` | random | title text(80), unit text(40), goal int, notes text(300), state enum `oc` |
| `BH` | random (the request) | state enum `sd` |
| `BC` | `1` | names [text(48)] ≤ 50 |
| `CFG` | `1` | officerRankMax int, relayRankMax int- (`-` = none) |
| `WH` | `1` | url text(250) |

**Expiry as coded** (ages from the version's t; evaluated at the start of the server hour; expired when the
expiry time ≤ that hour start): `cr` 30 d, 7 d when `x`/`d`; `DR` 180 d open, 60 d when `c`; `RD` startsAt + 45 d
(its tombstone t + 45 d); "with the parent" uses the parent's expiry (`su`, `RT` → `RD`; `cl` → `cr`; `BH` → `bq`;
`dc` → the `DR` named in its drive field), else t + 120 d; `rc` 60 d from the newer of itself and `ch:<name>`;
never-expiring types: tombstones t + 180 d; unknown types t + 14 d and at most 8,715 bytes. A raid close
(`RT` `d`, kind `r`) and every `LA` never expire until `LY:<instance>` has upto ≥ their t.

**Derived-state details.** `craftRequestState`: claims tied on claimedAt go to the smaller pid (bytes); a missing
claimedAt uses the claim's t. `bankRequestState`: a tie on t goes to the cancel. `countingReserves`: a missing
reservesAt uses the sign-up's t. `loyaltyFold`: an attendee also listed as a no-show keeps the bonus (the old
`closeRaid` did the same); duplicate snapshot items count once; an `LA` without a pid changes nothing.

**Messages as coded.** The protocol minor in `H` is `1`. `I` entries are sorted by shortId then v; a bucket
holds at most 35 pages. `G` carries as many shortIds as fit in 255 bytes (≤ 55), so a long target name gets
fewer per message. `R` packs records in the order given and skips records over 253 bytes (those go in `M`).
`M` parts are cut at ≤ 249 bytes on UTF-8 boundaries, so every part is valid text.
