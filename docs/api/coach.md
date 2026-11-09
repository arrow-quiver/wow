# Coach API

The Coach learns each character's play style from the addon, keeps a Claude-written build plan, works out next
steps, and answers questions. Implemented in `app/src/core/routes/coach.js`, `services/coach.js` (play style, plans,
answers, limits) and `services/ai.js` (Claude Messages API, cost metering). Conventions are in [core.md](core.md).
The Coach is personal: nothing here is shared with guildmates.

## How it works

- **From the game.** The addon records play style, the quiz, talents and gear in `WowGuildDB.coach`. The app's sync
  uploads it (`POST /api/sync` → `services/coach.applyCoach`); questions asked in game ride along and are stored with
  `source: "game"`. Plans and answers go back to the game in the inbox (`coach` part, see `services/coach.inboxPart`).
- **Claude.** The player's own Anthropic API key, entered in Settings → Coach and stored encrypted on this computer
  (secret `anthropicKey`; the page can set it but never read it back). Plans use `cfg.coachModel` (`claude-sonnet-5-5`,
  up to 4 web searches), answers use `cfg.coachFastModel` (`claude-haiku-5-5`, up to 2 searches). Web search is
  limited to WoW: Forever guides and databases (`ai.SEARCH_SITES`: wowhead.com, warcraft.wiki.gg, worldofwarcraft.blizzard.com, method.gg, mobalytics.gg, warcrafttavern.com, icy-veins.com). Reddit blocks Claude's search, so it is not on the list; a site the API refuses ("domains are not accessible") is dropped until the app restarts and the question is sent again without it. Every call is metered in `ai_usage`.
- **Limits.** **30 questions and 5 plans a day** (UTC). A **monthly budget** (USD, default 15) and an on/off switch
  for the AI live in Guild settings (`PUT /api/guild/settings { coach_enabled, coach_budget_usd }`, see core.md).
  Anyone can change them: the key and the bill are the player's own.
- **Without a key** play-style tracking and next steps still work; asking and plans are refused with a
  clear reason, and questions from the game are marked failed with that reason so the game shows it.
- **Background pass** (`services/coach.processPending`, every minute when timers run, and soon after `kick()`): answers
  waiting questions (6 per pass) and writes plans for characters that want one: no plan yet, a fresh plan asked for in
  game, or 3+ levels since the last plan (3 characters per pass). A plan that fails there is not retried until the next
  level-up or request.
- **App requests wait at most 12 s** (`cfg.coachWaitMs`) for Claude, which keeps them under the app's 20 s request
  limit. Anything slower carries on in the background and finishes with a `coach` event (below).
- The same question or plan is never paid for twice: a second plan request for a character joins the one being
  written, and the background pass skips anything an app request is already waiting on.

### Notifications (`coach` events)
Sent only to the member (`userId`) and only for work that finished in the background, so an answer the member already
got in the app doesn't pop up again. `route` is `/coach`.

| When | `title` | `body` |
|---|---|---|
| A question was answered in the background (asked in game, or an app question slower than 12 s) | `The Coach answered` | `<question, up to 60 characters>: <first line of the answer>` |
| An app question failed in the background | `The Coach couldn't answer` | the reason |
| A plan was written in the background (first plan, level-up, in-game request, or a slow app request) | `Your build plan for <name> is ready` | the plan's headline |
| A slow app plan request failed | `Your build plan for <name> couldn't be made` | the reason |

### Core hook
```js
ctx.services.coach.kick()   // schedule a background pass soon (no-op while cfg.timers is off, e.g. in tests)
await ctx.services.coach.run()  // run a pass now → { answered, plans, failed } (busy: true if one was already running)
```
The sync route calls `kick()` after an upload that brought in-game questions (`stats.coach.questions > 0`), or when
something is pending (`coachPending > 0`) and a key is set. Without a key a pass only marks waiting questions as
failed (no outside calls).

---

## `GET /api/coach?char=<name>` (guild)
Everything the Coach page shows, for one of **my** coach characters. `char` picks the character (exact name first, then
ignoring case); without it, or when it doesn't match, the most recently synced character is used.

```json
{
  "characters": [
    { "name": "Grom", "class": "WARRIOR", "level": 24, "realm": "Forever", "updated_at": "2026-11-07 18:02:11",
      "archetype": "Warmonger", "hasPlan": true }
  ],
  "character": {
    "name": "Grom", "class": "WARRIOR", "level": 24, "realm": "Forever",
    "profile": { "scores": { "aggression": 82, "risk": 40, "social": 30, "pvp": 75, "pace": 60 },
                 "archetype": "Warmonger", "blurb": "You go looking for fights.", "minutes": 300, "quiz": true },
    "stats": { "minutes": 300, "pullsPerHour": 41, "deathsPerHour": 0.8, "honorKills": 30, "duelsWon": 2, "duelsLost": 1,
               "questsPerHour": 3.5, "groupedShare": 0.2, "flaggedShare": 0.9, "battlegroundMinutes": 0, "dungeonMinutes": 30 },
    "quiz": { "aggression": 5, "risk": 2, "social": 1, "pvp": 5, "pace": 3, "role": "Damage", "goal": "World PvP" },
    "talents": { "trees": [ { "name": "Arms", "points": 15 }, { "name": "Fury", "points": 0 }, { "name": "Protection", "points": 0 } ],
                 "unspent": 1, "picked": [ { "name": "Improved Rend", "rank": 3, "max": 3, "tree": "Arms" } ] },
    "gear": { "items": [ { "slot": "Main hand", "id": 15223, "name": "Bonebiter", "ilvl": 30, "quality": 2 } ],
              "lowestDurability": 80, "freeSlots": 12 },
    "plan_at": "2026-11-07 17:00:00", "plan_level": 24, "plan_requested_at": null,
    "updated_at": "2026-11-07 18:02:11"
  },
  "plan": {
    "headline": "Arms for world PvP: hit hard, stay mobile",
    "summary": "You start fights and like PvP, so go deep Arms for burst.",
    "spec": "Arms", "split": "31/20/0 at 60",
    "talents": [
      { "name": "Improved Rend", "tree": "Arms", "points": 3, "why": "Early damage", "taken": true, "rank": 3 },
      { "name": "Tactical Mastery", "tree": "Arms", "points": 5, "why": "Keep rage on stance swap", "taken": false, "rank": null }
    ],
    "stats": ["Strength", "Hit", "Crit"],
    "gear": [ { "slot": "Weapon", "advice": "Slow two-hander for big Overpower hits" } ],
    "next_steps": [ { "title": "Spend your talent point", "detail": "Put it in Tactical Mastery" } ],
    "tips": ["Open with Charge from max range"],
    "confidence": "classic", "level": 24, "model": "claude-sonnet-5-5", "at": 1762534800,
    "sources": [ { "url": "https://www.wowhead.com/forever/guide/arms", "title": "Arms guide" } ]
  },
  "planBusy": false,
  "nextSteps": [
    { "kind": "talent", "title": "Spend 1 talent point", "detail": "Your plan says: Tactical Mastery (Arms)." },
    { "kind": "raid", "title": "Sign up: Molten Core", "detail": "Pick a character and role in Guild Camp.",
      "route": "/raids/12", "at": "2026-11-09T19:00:00.000Z" },
    { "kind": "plan", "title": "Spend your talent point", "detail": "Put it in Tactical Mastery" }
  ],
  "questions": [
    { "id": 7, "char_name": "Grom", "source": "app", "question": "Best place to level at 24?",
      "answer": "Stranglethorn Vale...", "sources": [ { "url": "https://www.wowhead.com/…", "title": "…" } ],
      "status": "answered", "error": null, "created_at": "2026-11-07 18:05:00", "answered_at": "2026-11-07 18:05:06" }
  ],
  "limits": { "questionsPerDay": 30, "plansPerDay": 5, "questionsLeft": 29, "plansLeft": 4 },
  "ai": { "available": true, "hasKey": true, "enabled": true, "budgetLeft": true, "reason": null },
  "usage": { "month": "2026-11", "spentUsd": 0.0231, "budgetUsd": 15, "questions": 12, "plans": 3 }
}
```

- `characters` newest sync first. `character`, `plan` are `null` when the member has no coach data yet (nothing synced
  with the addon's Coach); `nextSteps` is then `[]`.
- `character.profile`, `stats`, `quiz`, `talents`, `gear` are the addon's data as uploaded (each may be `null`).
  The five scores are 0–100: `aggression` (how readily you start fights), `risk` (how often fights go wrong),
  `social` (time spent grouped), `pvp` (flagged, battlegrounds, kills, duels), `pace` (fighting and questing per hour).
  `profile.blurb` describes the archetype. `profile.quiz` says whether the quiz was answered; `minutes` is play watched.
- `plan` is the stored plan. Each talent adds `taken` (the character has at least one rank) and `rank` (current rank or
  `null`). `confidence` is `"forever"` when Claude confirmed WoW: Forever specifics with search, else `"classic"`.
  `at` is Unix seconds. `sources` are http(s) links only. A plan the background pass couldn't make is
  `{ "error": "…", "at": 1762534800 }`.
- `planBusy`: a plan is being written right now, or the background pass will write one shortly (only when the AI is
  available and timers run).
- `nextSteps`, in this order (same rules and wording as the addon; the class-trainer reminder only exists in game):
  `talent` unspent points (with the first plan talent not yet taken), `repair` lowest durability under 25%, `bags` fewer
  than 4 free slots, `prof` a main profession more than 30 points behind `min(level × 5, max)` (not Fishing, Cooking,
  First Aid), `quiz` the quiz isn't answered, `raid` the next open event without my sign-up (`route`, `at` ISO start),
  then each `plan` step.
- `questions`: my latest 15 across all my characters, newest first. `source` is `app` or `game`. `status` is
  `pending` (Claude is on it), `answered` or `failed` (`error` says why).
- `ai.available` = an Anthropic key is set **and** the Coach's AI is switched on **and** this month's spend is under
  the budget. `reason` is a sentence for people when it isn't. Daily limits are separate (`limits`).
- `usage`: this calendar month (UTC): spend in USD, the budget, and how many questions and plans were made. Everyone
  sees it, because the key and the budget are the player's own.

## `POST /api/coach/ask` (guild)
```json
{ "char": "Grom", "question": "Should I take Improved Charge or Deflection for world PvP?", "fresh": false, "live": "" }
```
`live` (optional, cut to 2,500 characters) is what the app's live link saw in the combat log: the last death's recap
(killer, killing blow, damage by source, heals, my casts) or this play session's numbers. The Coach overlay sends it
for "Why did I die?" and when "Include this session" is ticked. Claude sees it after the character's details as
`From the game, live (the combat log): …`.
`question` is trimmed and cut to 500 characters. `char` picks which of my characters the question is about (falls
back to my most recently synced one; it is stored as `char_name`, or `null` if I have none).

**Follow-ups.** Unless `fresh` is `true`, Claude also sees up to 3 earlier answered questions about the same character
from the 3 hours before this one, as the conversation so far (the character's details go with the first of them, and
this question is sent as `Follow-up question: …`). So "And at level 40?" makes sense after "Best place to level at 24?".
Questions asked in game are always follow-ups.

Answered in time → `200`; still thinking after 12 s → `202` (the answer arrives later with a `coach` event):
```json
{ "question": { "id": 8, "char_name": "Grom", "source": "app", "question": "…", "answer": "Take Deflection for now…",
                "sources": [ { "url": "https://www.wowhead.com/…", "title": "…" } ], "status": "answered",
                "error": null, "created_at": "…", "answered_at": "…" },
  "message": "The Coach answered." }
```
```json
{ "question": { "id": 9, "status": "pending", "answer": null, "...": "…" },
  "message": "The Coach is still thinking. The answer shows here when it's ready." }
```
If Claude fails, the question is stored as `failed` and the answer is `200` with
`"message": "No answer: Claude API 529: overloaded"`.

Refused before anything is stored or sent:
- Empty question → `400 "Type a question first."`
- No key → `503 "The Coach's AI answers are off. Add your Anthropic API key in Settings to turn them on."`
- `403` with one of: `"The Coach's AI answers are switched off in Guild settings."`,
  `"Your Coach budget for this month is used up. You can raise it in Guild settings."`,
  `"You've reached today's limit of 30 questions. It resets at midnight (UTC)."`

## `POST /api/coach/plan` (guild)
```json
{ "char": "Grom" }
```
Writes a fresh build plan for that character (or my most recently synced one). Pressing it again while a plan is being
written joins that request instead of starting another.

Ready in time → `200`:
```json
{ "status": "ready", "char": "Grom", "plan": { "headline": "…", "talents": [ { "name": "…", "taken": true, "rank": 3, "...": "…" } ], "...": "same shape as GET" },
  "message": "Your new build plan is ready. It reaches the game after your next sync and /reload." }
```
While the game's news folder waits for a game restart (sync status `restartNeeded`), the app shows this reply as
"Your new build plan is ready. It reaches the game after you restart World of Warcraft. A /reload isn't enough the
first time." (SHARING.md §2).
Still being written after 12 s → `202` (a `coach` event follows, ready or failed):
```json
{ "status": "pending", "char": "Grom", "message": "The Coach is writing your plan. It can take a minute; it shows here when it's ready." }
```
Errors:
- No coach data for me → `400 "No character data yet. Log in with the addon and sync once."`
- No key → `503` (as above). Switched off, budget, or `"You've reached today's limit of 5 build plans. It resets at midnight (UTC)."` → `403`
- Claude failed or returned something that isn't a plan → `502` (`"Claude API 500: …"`, `"Could not reach the Claude API. Try again in a minute."`, `"The Coach didn't return a plan. Try again."`)
