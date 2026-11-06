const { esc, classInfo, ago } = require('./layout');
const { itemLink, spellLink, game: wowheadGame, GAMES } = require('./wowhead');

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;

function charName(c, { link = true } = {}) {
  const [label, color] = classInfo(c.class);
  const inner = `<span class="cname" style="--cc:${color}">${esc(c.name)}</span>`;
  return link ? `<a href="/characters/${encodeURIComponent(c.name)}" class="clink" title="${esc(label)}">${inner}</a>` : inner;
}

// ---------- Signed out / onboarding ----------

function landing({ devLogin, bnetEnabled }) {
  return `<section class="welcome">
    <svg class="welcome-fire" viewBox="0 0 120 140" aria-hidden="true">${fireSvg()}</svg>
    <h1>Pull up a log.</h1>
    <p class="lede">The guild's camp: who's online, who can craft what, who's leveling where, and where the fighting is.</p>
    <div class="actions">
      <a href="/get">Get the addon and companion</a>
      ${bnetEnabled ? '<a class="btn btn-primary" href="/auth/bnet">Sign in with Battle.net</a>' : ''}
      ${devLogin ? `<form method="post" action="/login/dev" class="inline-form">
        <label class="sr" for="bt">BattleTag</label>
        <input id="bt" name="battletag" placeholder="Name#1234" required pattern=".+#\\d+">
        <button class="btn">Sign in (dev)</button></form>` : ''}
      ${!bnetEnabled && !devLogin ? '<p class="muted">Sign-in is not set up yet. Add the Battle.net keys to the server settings.</p>' : ''}
    </div>
  </section>`;
}

function setup({ csrf, invite }) {
  return `<section class="welcome">
    <h1>${invite ? `Join ${esc(invite.name)}` : 'Start your guild camp'}</h1>
    ${invite ? `<form method="post" action="/join/${esc(invite.invite_code)}" class="stack">${csrfField(csrf)}
        <button class="btn btn-primary">Join ${esc(invite.name)}</button></form>`
      : `<p class="lede">Nobody has set up a guild here yet. Name it and you become its owner. Everyone else joins with your invite link.</p>
      <form method="post" action="/guild/create" class="stack narrow">${csrfField(csrf)}
        <label>Guild name<input name="name" required maxlength="40" value="wow"></label>
        <label>Faction<select name="faction"><option>Horde</option><option>Alliance</option></select></label>
        <button class="btn btn-primary">Create guild</button>
      </form>
      <p class="muted">Got an invite link? Open it to join that guild instead.</p>`}
  </section>`;
}

// ---------- Camp (dashboard) ----------

function fireSvg() {
  return `<g class="fire">
    <path class="flame f1" d="M60 18 C75 45 92 62 86 92 C82 112 68 120 60 120 C52 120 38 112 34 92 C28 62 45 45 60 18Z"/>
    <path class="flame f2" d="M60 52 C68 68 76 78 73 96 C71 108 65 113 60 113 C55 113 49 108 47 96 C44 78 52 68 60 52Z"/>
    <rect class="log" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(-10 60 122)"/>
    <rect class="log" x="22" y="118" width="76" height="9" rx="4.5" transform="rotate(10 60 122)"/>
  </g>`;
}

function campRing(online, scannedAt) {
  const stale = !scannedAt || Date.now() - new Date(scannedAt).getTime() > 30 * 60 * 1000;
  const shown = online.slice(0, 14);
  const n = Math.max(shown.length, 1);
  const seats = shown.map((c, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(a) * 35;
    const y = 50 + Math.sin(a) * 35;
    const [label, color] = classInfo(c.class);
    return `<a class="seat" href="/characters/${encodeURIComponent(c.name)}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--cc:${color}">
      <span class="seat-dot">${esc(c.name.slice(0, 2))}</span>
      <span class="seat-name">${esc(c.name)}</span>
      <span class="sr">${esc(label)}, level ${esc(c.level)}, ${esc(c.zone || '')}</span></a>`;
  }).join('');
  const extra = online.length > shown.length ? `<p class="muted">and ${online.length - shown.length} more online</p>` : '';
  return `<section class="camp${stale ? ' is-stale' : ''}" aria-labelledby="camp-h">
    <div class="ring">
      <svg class="ring-fire" viewBox="0 0 120 140" aria-hidden="true">${fireSvg()}</svg>
      ${seats}
    </div>
    <div class="camp-copy">
      <h1 id="camp-h">${online.length ? `${online.length} around the fire` : 'The fire is quiet'}</h1>
      <p class="muted">${scannedAt ? `Guild roster as of ${ago(scannedAt)}${stale ? '. Anyone running the companion updates it when they log out or reload.' : '.'}` : 'Nobody has synced yet. Install the addon and companion from Settings.'}</p>
      ${extra}
    </div>
  </section>`;
}

function onboardingBox(steps) {
  if (!steps || steps.every((x) => x.done)) return '';
  const done = steps.filter((x) => x.done).length;
  return `<section class="onboard" aria-labelledby="ob-h">
    <h2 id="ob-h">Get set up <span class="muted small">${done} of ${steps.length} done</span></h2>
    <ol>${steps.map((x) => `<li class="${x.done ? 'is-done' : ''}">${x.done ? `<span>${esc(x.label)}</span>` : `<a href="${esc(x.href)}">${esc(x.label)}</a>`}</li>`).join('')}</ol>
  </section>`;
}

function home({ csrf, online, scannedAt, ctas, announcements, activity, isOfficer, mySync, onboarding, realm }) {
  return `${onboardingBox(onboarding)}${realmLine(realm)}${campRing(online, scannedAt)}
  <div class="cols">
    <section class="col-main">
      <h2>Call to arms</h2>
      <form method="post" action="/cta" class="cta-form">${csrfField(csrf)}
        <label>Where<input name="zone" required maxlength="60" placeholder="The Crossroads"></label>
        <label>Need<input name="needed" type="number" min="1" max="40" value="5"></label>
        <label class="grow">What's happening<input name="message" maxlength="200" placeholder="Alliance raid hitting the flight master"></label>
        <button class="btn btn-alarm">Sound the horn</button>
      </form>
      <p class="hint">Posts to Discord straight away. In game, type <code>/wow cta Crossroads 5 need help</code>. It sends on your next reload or logout.</p>
      <ol class="feed">
        ${ctas.length ? ctas.map((c) => `<li class="feed-item cta-item"><strong>${esc(c.zone)}</strong>${c.needed ? ` <span class="pill">need ${esc(c.needed)}</span>` : ''}
          <span>${esc(c.message || '')}</span> <span class="muted">${esc(c.character || c.battletag)}, ${ago(c.created_at)}</span></li>`).join('')
          : '<li class="empty">No calls in the last day.</li>'}
      </ol>

      <h2>Around camp</h2>
      <ol class="feed">
        ${activity.length ? activity.map((a) => `<li class="feed-item">${esc(a.text)} <span class="muted">${ago(a.created_at)}</span></li>`).join('')
          : '<li class="empty">Things people do show up here: new characters, crafting requests, leveling partners.</li>'}
      </ol>
    </section>
    <aside class="col-side">
      <h2>Notices</h2>
      ${isOfficer ? `<form method="post" action="/announcements" class="stack">${csrfField(csrf)}
        <label class="sr" for="ann">New notice</label>
        <textarea id="ann" name="body" rows="3" maxlength="500" required placeholder="Raid sign-ups open Sunday"></textarea>
        <button class="btn">Post notice</button></form>` : ''}
      <ul class="notices">
        ${announcements.length ? announcements.map((a) => `<li><p>${esc(a.body)}</p><span class="muted">${esc(a.battletag)}, ${ago(a.created_at)}</span></li>`).join('')
          : '<li class="empty">No notices yet.</li>'}
      </ul>
      <h2>Your sync</h2>
      <p class="muted">${mySync ? `Last upload ${ago(mySync)}.` : 'Not synced yet. <a href="/settings">Set up the companion</a>.'}</p>
    </aside>
  </div>`;
}

// ---------- Roster & characters ----------

function realmLine(r) {
  if (!r || !r.found) return '';
  const state = r.up === false ? '<span class="realm-down">Down</span>' : r.up ? '<span class="realm-up">Up</span>' : 'Unknown';
  return `<p class="realm-line"><strong>${esc(r.name)}</strong> ${state}${r.queue ? ' · <strong>login queue</strong>' : ''}${r.population ? ` · ${esc(r.population)} population` : ''} <span class="muted">· checked ${ago(r.checkedAt)}</span></p>`;
}

function roster({ chars, scannedAt }) {
  const rows = chars.map((c) => {
    const [label] = classInfo(c.class);
    return `<tr${c.online ? ' class="is-online"' : ''}>
      <td>${c.online ? '<span class="dot" title="Online"></span>' : ''}${charName(c)}${c.is_main ? ' <span class="pill">main</span>' : ''}</td>
      <td>${esc(c.level ?? '')}</td><td>${esc(label)}</td><td>${esc(c.rank || '')}</td>
      <td>${esc(c.zone || '')}</td><td>${esc(c.battletag ? c.battletag.split('#')[0] : '')}</td>
      <td class="muted">${c.online ? 'now' : c.last_seen ? ago(c.last_seen) : c.in_official_roster ? '<span title="From Blizzard\'s official guild list">in guild</span>' : ''}</td></tr>`;
  }).join('');
  return `<h1>Roster</h1>
  <p class="muted">${chars.length} characters. Roster as of ${ago(scannedAt)}. A player name means that member has linked the character with the companion.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Level</th><th>Class</th><th>Rank</th><th>Zone</th><th>Player</th><th>Seen</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No characters yet. The roster fills in after the first sync.</td></tr>'}</tbody>
  </table></div>`;
}

const STANDING = ['', 'Hated', 'Hostile', 'Unfriendly', 'Neutral', 'Friendly', 'Honored', 'Revered', 'Exalted'];
function extrasSection(raw) {
  let x; try { x = raw ? JSON.parse(raw) : null; } catch { x = null; }
  if (!x) return '';
  const parts = [];
  if (x.pvp) {
    const p = x.pvp;
    const facts = [
      p.rankName ? `Rank: <strong>${esc(p.rankName)}</strong>${p.rank ? ` (${esc(p.rank)})` : ''}` : '',
      p.highestRank ? `Highest rank ${esc(p.highestRank)}` : '',
      p.honor != null ? `Honor: ${esc(p.honor.toLocaleString('en'))}` : '',
      p.honorLevel ? `Honor level ${esc(p.honorLevel)}` : '',
      p.hk != null ? `${esc(p.hk.toLocaleString('en'))} honorable kills` : '',
      p.weekHk != null ? `This week: ${esc(p.weekHk)} kills${p.weekContribution ? `, ${esc(p.weekContribution.toLocaleString('en'))} honor` : ''}` : '',
      p.lastWeekRank ? `Last week's standing: ${esc(p.lastWeekRank)}` : '',
    ].filter(Boolean);
    if (facts.length) parts.push(`<h2>PvP</h2><ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>`);
  }
  if (x.currencies && x.currencies.length) {
    parts.push(`<h2>Currencies</h2><ul class="facts">${x.currencies.map((cc) => `<li>${esc(cc.name)}: <strong>${esc(cc.qty.toLocaleString('en'))}</strong>${cc.max ? ` <span class="muted">of ${esc(cc.max.toLocaleString('en'))}</span>` : ''}</li>`).join('')}</ul>`);
  }
  if (x.reputations && x.reputations.length) {
    const reps = x.reputations.filter((r) => r.standing && r.standing !== 4 || r.value);
    parts.push(`<details class="recipes"><summary>Reputations (${reps.length})</summary><ul class="profs">${reps.map((r) => {
      const pct = r.max ? Math.max(0, Math.min(100, Math.round((r.value / r.max) * 100))) : null;
      return `<li><strong>${esc(r.name)}</strong>${pct != null ? `<span class="bar" role="img" aria-label="${pct}% to next standing"><span style="width:${pct}%"></span></span>` : '<span></span>'}
        <span class="muted">${esc(STANDING[r.standing] || '')}</span></li>`;
    }).join('')}</ul></details>`);
  }
  return parts.join('');
}

function character({ c, profs, recipes, csrf, isOwner, alts }) {
  const [label, color] = classInfo(c.class);
  const byProf = {};
  for (const r of recipes) (byProf[r.profession] ||= []).push(r);
  return `<p class="crumb"><a href="/roster">Roster</a></p>
  <h1 class="char-h" style="--cc:${color}">${esc(c.name)}</h1>
  <p class="lede">Level ${esc(c.level ?? '?')} ${esc(c.race || '')} ${esc(label)}${c.zone ? `, last in ${esc(c.zone)}` : ''}${c.rank ? `. ${esc(c.rank)}` : ''}.</p>
  ${isOwner && !c.is_main ? `<form method="post" action="/characters/${encodeURIComponent(c.name)}/main">${csrfField(csrf)}<button class="btn">Make this my main</button></form>` : ''}
  ${alts.length ? `<p>Same player: ${alts.map((a) => charName(a)).join(', ')}</p>` : ''}
  ${extrasSection(c.extras)}
  <h2>Professions</h2>
  ${profs.length ? `<ul class="profs">${profs.map((p) => `<li><strong>${esc(p.name)}</strong>
     <span class="bar" role="img" aria-label="${esc(p.skill)} of ${esc(p.max_skill)}"><span style="width:${Math.min(100, (p.skill / (p.max_skill || 300)) * 100)}%"></span></span>
     <span class="muted">${esc(p.skill)} / ${esc(p.max_skill)}</span></li>`).join('')}</ul>`
    : '<p class="empty">No professions synced. Open each profession window once in game, then reload.</p>'}
  ${Object.entries(byProf).map(([p, names]) => `<details class="recipes"><summary>${esc(p)} recipes (${names.length})</summary>
     <ul class="cols-list">${names.map((n) => `<li>${spellLink(n.recipe_id, n.name)}</li>`).join('')}</ul></details>`).join('')}`;
}

// ---------- Crafters ----------

function shoppingSection(shopping) {
  if (!shopping) return '';
  const { money } = require('../economy');
  const total = shopping.mats.reduce((t, m) => t + (m.price != null ? m.price * m.need : 0), 0);
  return `<section class="setting">
    <h2>Your shopping list</h2>
    <p class="muted">From the addon, as of ${ago(shopping.updatedAt)}: ${shopping.items.map((e) => `${esc(e.qty)} × ${esc(e.name)}`).join(', ')}.
      ${total ? `Buying everything would cost about ${esc(money(total))}.` : ''} Manage it in game with <code>/wow list</code>.</p>
    <div class="table-wrap"><table><thead><tr><th>Mat</th><th class="num">Need</th><th>Where you have it</th><th class="num">Guild bank</th><th class="num">Each</th></tr></thead><tbody>
      ${shopping.mats.map((m) => `<tr><td>${itemLink(m.id, m.name)}</td><td class="num">${esc(m.need)}</td>
        <td>${m.chars.length ? m.chars.map((c) => `${esc(c.name)} ${esc(c.n)}`).join(', ') : '<span class="muted">none synced</span>'}</td>
        <td class="num">${m.guildBank || ''}</td><td class="num">${m.price != null ? esc(money(m.price)) : ''}</td></tr>`).join('')}
    </tbody></table></div>
  </section>`;
}

function crafters({ q, results, profSummary, shopping }) {
  return `<h1>Crafters</h1>
  ${shoppingSection(shopping)}
  <form method="get" action="/crafters" class="search" role="search">
    <label class="sr" for="q">Search recipes</label>
    <input id="q" name="q" value="${esc(q)}" placeholder="Search a recipe, e.g. Heavy Silk Bandage" autofocus>
    <button class="btn">Search</button>
  </form>
  ${q ? `<h2>${results.length ? `Who can make “${esc(q)}”` : `Nobody has a recipe matching “${esc(q)}”`}</h2>
    ${results.length ? `<ul class="results">${results.map((r) => `<li>
      <span class="r-name">${spellLink(r.recipeId, r.recipe)}</span>
      <span>${r.crafters.map((c) => `${c.online ? '<span class="dot" title="Online"></span>' : ''}${charName(c)}`).join(', ')}</span>
      <a class="btn btn-small" href="/requests?item=${encodeURIComponent(r.recipe)}">Request</a></li>`).join('')}</ul>`
      : '<p class="muted">Try part of the name. Recipes only show up once their owner has opened that profession in game and synced.</p>'}`
    : `<h2>Guild professions</h2>
    ${profSummary.length ? `<ul class="prof-summary">${profSummary.map((p) => `<li><strong>${esc(p.name)}</strong>
      <span>${p.chars.map((c) => `${charName(c)} <span class="muted">${esc(c.skill)}</span>`).join(', ')}</span></li>`).join('')}</ul>`
      : '<p class="empty">No professions synced yet.</p>'}`}`;
}

// ---------- Crafting requests ----------

function requests({ csrf, rows, userId, prefill }) {
  const groups = { open: [], claimed: [], done: [] };
  for (const r of rows) (groups[r.status] || []).push(r);
  const item = (r) => `<li class="req">
    <div><strong>${esc(r.item)}</strong>${r.notes ? `<p>${esc(r.notes)}</p>` : ''}
      <span class="muted">for ${esc(r.requester.split('#')[0])}${r.crafter ? `, ${r.status === 'done' ? 'made' : 'claimed'} by ${esc(r.crafter.split('#')[0])}` : ''}, ${ago(r.updated_at)}</span>
      ${r.status === 'open' ? `<span class="muted block">${r.crafters ? `Can craft: ${esc(r.crafters)}` : 'Nobody has synced this recipe yet.'}</span>` : ''}</div>
    <div class="req-actions">
      ${r.status === 'open' && r.requester_id !== userId ? action(r.id, 'claim', 'I’ll make it', csrf) : ''}
      ${r.status === 'claimed' && (r.crafter_id === userId || r.requester_id === userId) ? action(r.id, 'done', 'Mark as delivered', csrf) : ''}
      ${r.requester_id === userId && r.status !== 'done' ? action(r.id, 'cancel', 'Cancel', csrf, true) : ''}
    </div></li>`;
  return `<h1>Crafting requests</h1>
  <form method="post" action="/requests" class="req-form">${csrfField(csrf)}
    <label class="grow">Item<input name="item" required maxlength="100" value="${esc(prefill)}" placeholder="Exact recipe name"></label>
    <label class="grow">Notes<input name="notes" maxlength="200" placeholder="I have the mats, will mail them"></label>
    <button class="btn btn-primary">Post request</button>
  </form>
  <p class="hint">Crafters who know this recipe see the request in game next time they reload.</p>
  <h2>Open</h2><ul class="reqs">${groups.open.map(item).join('') || '<li class="empty">Nothing waiting.</li>'}</ul>
  <h2>Being made</h2><ul class="reqs">${groups.claimed.map(item).join('') || '<li class="empty">Nothing in progress.</li>'}</ul>
  <h2>Delivered recently</h2><ul class="reqs">${groups.done.map(item).join('') || '<li class="empty">Nothing delivered yet.</li>'}</ul>`;
}
function action(id, verb, label, csrf, quiet) {
  return `<form method="post" action="/requests/${id}/${verb}">${csrfField(csrf)}<button class="btn btn-small${quiet ? ' btn-quiet' : ''}">${label}</button></form>`;
}

// ---------- Leveling partners ----------

function buddies({ csrf, posts, myChars, userId }) {
  return `<h1>Leveling partners</h1>
  <p class="lede">Post where you're questing and when. Anyone within a few levels can come along.</p>
  <form method="post" action="/buddies" class="req-form">${csrfField(csrf)}
    <label>Character${myChars.length ? `<select name="character">${myChars.map((c) => `<option value="${esc(c.name)}">${esc(c.name)} (${esc(c.level)})</option>`).join('')}</select>`
      : '<input name="character" required maxlength="40">'}</label>
    <label class="grow">Zone<input name="zone" maxlength="60" placeholder="Stonetalon Mountains"></label>
    <label class="grow">When<input name="when_text" maxlength="60" placeholder="Tonight 8pm"></label>
    <label class="grow">Note<input name="note" maxlength="140" placeholder="Doing the Venture Co. chain"></label>
    <button class="btn btn-primary">Post</button>
  </form>
  <ul class="reqs">${posts.map((p) => `<li class="req"><div>
      ${charName({ name: p.character, class: p.class })} <span class="pill">level ${esc(p.level ?? '?')}</span>
      ${p.zone ? `in <strong>${esc(p.zone)}</strong>` : ''} ${p.when_text ? `, ${esc(p.when_text)}` : ''}
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}<span class="muted">${ago(p.created_at)}</span></div>
      ${p.user_id === userId ? `<div class="req-actions"><form method="post" action="/buddies/${p.id}/close">${csrfField(csrf)}<button class="btn btn-small btn-quiet">Remove</button></form></div>` : ''}
    </li>`).join('') || '<li class="empty">Nobody has posted yet. Be the first.</li>'}</ul>`;
}

// ---------- Settings ----------

function memberAction(id, verb, label, csrf, confirm) {
  return `<form method="post" action="/members/${id}/${verb}">${csrfField(csrf)}<button class="btn btn-small btn-quiet"${confirm ? ` data-confirm="${esc(confirm)}"` : ''}>${label}</button></form>`;
}

function settings({ csrf, tokens, newToken, guild, baseUrl, isOfficer, isOwner, me, members, discordInfo = {}, calendarUrl, pushDevices = 0, pushPrefs, gameData = {}, coachInfo = {} }) {
  return `<h1>Settings</h1>
  <section class="setting">
    <h2>Connect the game</h2>
    <ol class="steps">
      <li><a href="/get">Download the addon and companion</a>, then copy the <code>WowGuild</code> folder into <code>World of Warcraft\\_forever_\\Interface\\AddOns</code>. The folder name may differ: use whichever one holds Forever.</li>
      <li>Download the companion below. It comes set up with this site's address and your own sync key. Unzip it anywhere.</li>
      <li>Run <code>wow-companion.exe</code> and leave it open while you play. It uploads every time you log out or reload.</li>
    </ol>
    <form method="post" action="/settings/companion" class="actions-row">${csrfField(csrf)}<button class="btn btn-primary">Download companion, ready to go</button></form>
    <details><summary>Set it up by hand instead</summary><ol class="steps">
      <li>Create a sync key below. In <code>config.json</code>, set <code>syncKey</code> to it and <code>siteUrl</code> to <code>${esc(baseUrl)}</code>.</li>
    </ol></details>
    ${newToken ? `<div class="token-once"><p>Your new sync key. Copy it now, because it won't be shown again:</p><code class="token">${esc(newToken)}</code></div>` : ''}
    <form method="post" action="/settings/token">${csrfField(csrf)}<button class="btn btn-primary">Create sync key</button></form>
    ${tokens.length ? `<ul class="tokens">${tokens.map((t) => `<li><code>${esc(t.prefix)}…</code> <span class="muted">created ${ago(t.created_at)}, last used ${ago(t.last_used_at)}</span>
      <form method="post" action="/settings/token/${t.id}/revoke">${csrfField(csrf)}<button class="btn btn-small btn-quiet">Revoke</button></form></li>`).join('')}</ul>` : ''}
  </section>
  <section class="setting">
    <h2>Invite members</h2>
    <p>Send this link to guildies. They sign in with Battle.net and they're in.</p>
    <code class="token">${esc(baseUrl)}/join/${esc(guild.invite_code)}</code>
  </section>
  <section class="setting">
    <h2>Notifications on your phone and computer</h2>
    <p>Get a notification for calls to arms, new raids and reminders, guild notices, and crafting or bank requests meant for you.
      ${pushDevices ? `<strong>On for ${pushDevices} device${pushDevices === 1 ? '' : 's'}.</strong>` : ''}</p>
    <div class="actions-row" id="push-controls" data-csrf="${esc(csrf)}">
      <button class="btn btn-primary" type="button" data-push="on">Turn on for this device</button>
      <button class="btn btn-quiet" type="button" data-push="off" ${pushDevices ? '' : 'hidden'}>Turn off for this device</button>
      ${pushDevices ? `<form method="post" action="/push/test">${csrfField(csrf)}<button class="btn">Send a test</button></form>` : ''}
    </div>
    <p class="hint" id="push-status">On iPhone, first add this site to your Home Screen (Share → Add to Home Screen), then open it from there.</p>
    ${pushDevices ? `<form method="post" action="/push/prefs" class="inline-form">${csrfField(csrf)}
      ${[['cta', 'Calls to arms'], ['raids', 'Raids and reminders'], ['notices', 'Guild notices'], ['requests', 'Requests for me']].map(([k, l]) =>
        `<label class="check"><input type="checkbox" name="${k}"${!pushPrefs || pushPrefs[k] !== false ? ' checked' : ''}> ${l}</label>`).join('')}
      <button class="btn btn-small">Save choices</button></form>` : ''}
  </section>
  <section class="setting">
    <h2>Raids in your calendar</h2>
    <p>Add the guild's raids and events to Google, Apple or Outlook calendar. They update by themselves, with a reminder 30 minutes before.</p>
    <div class="actions-row">
      <a class="btn btn-primary" href="${esc(calendarUrl.replace(/^https?:/, 'webcal:'))}">Add to Apple or Outlook calendar</a>
      <a class="btn" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calendarUrl.replace(/^https?:/, 'webcal:'))}" target="_blank" rel="noopener">Add to Google Calendar</a>
    </div>
    <p class="hint">Or paste this private address into any calendar app: <code class="token">${esc(calendarUrl)}</code></p>
    <form method="post" action="/settings/calendar/reset">${csrfField(csrf)}<button class="btn btn-small btn-quiet" data-confirm="Make a new calendar link? The old one stops working.">Replace calendar link</button></form>
  </section>
  <section class="setting">
    <h2>Discord commands</h2>
    ${discordInfo.configured ? `<p>Use <code>/online</code>, <code>/raids</code>, <code>/craft</code>, <code>/price</code>, <code>/cta</code> and <code>/signup</code> straight from Discord.
      ${discordInfo.linked ? 'Your Discord is linked.' : 'Link your Discord once so <code>/signup</code> and <code>/cta</code> know who you are.'}</p>
      <div class="actions-row">
        <form method="post" action="/settings/discord/link">${csrfField(csrf)}<button class="btn${discordInfo.linked ? '' : ' btn-primary'}">${discordInfo.linked ? 'Get a new link code' : 'Link Discord'}</button></form>
        ${discordInfo.linked ? `<form method="post" action="/settings/discord/unlink">${csrfField(csrf)}<button class="btn btn-quiet">Unlink</button></form>` : ''}
      </div>
      ${isOfficer ? `<div class="officer-box">
        <p>${discordInfo.serverLinked ? 'Your Discord server is connected.' : 'The server connects automatically the first time someone runs <code>/link</code> in it.'}
        To add the commands to your server, <a href="https://discord.com/oauth2/authorize?client_id=${esc(discordInfo.appId)}&amp;scope=bot%20applications.commands&amp;permissions=8589934592" target="_blank" rel="noopener">invite the app</a>, then register them. Inviting it as a bot lets it also put raids in Discord's Events list.</p>
        <form method="post" action="/settings/discord/register">${csrfField(csrf)}<button class="btn">Register slash commands</button></form>
      </div>` : ''}`
    : '<p class="muted">Not set up yet. An officer needs to add the Discord app details to the server.</p>'}
  </section>
  ${isOfficer ? `<section class="setting">
    <h2>Discord channel posts</h2>
    <p>Paste a Discord webhook URL (Channel settings → Integrations → Webhooks). Calls to arms, notices and crafting requests get posted there.</p>
    <form method="post" action="/settings/webhook" class="inline-form">${csrfField(csrf)}
      <label class="sr" for="wh">Webhook URL</label>
      <input id="wh" name="webhook" type="url" value="${esc(guild.discord_webhook || '')}" placeholder="https://discord.com/api/webhooks/…" pattern="https://(discord|discordapp)\\.com/api/webhooks/.+">
      <button class="btn">Save webhook</button></form>
  </section>
  <section class="setting">
    <h2>Item tooltips</h2>
    <p>Hovering an item anywhere on the site shows its Wowhead tooltip. Pick the game your guild plays so the stats match.</p>
    <form method="post" action="/settings/wowhead" class="inline-form">${csrfField(csrf)}
      <label class="sr" for="whg">Game</label>
      <select id="whg" name="game">${GAMES.map((g) => `<option value="${g}"${g === wowheadGame() ? ' selected' : ''}>${g === 'forever' ? 'WoW: Forever' : g === 'retail' ? 'Retail' : 'Classic'}</option>`).join('')}</select>
      <button class="btn">Save</button></form>
  </section>
  <section class="setting">
    <h2>Coach (Claude AI)</h2>
    <p>${coachInfo.hasKey ? 'The Coach writes build plans and answers questions with Claude.' : '<span class="warn">No Claude API key on the server yet, so plans and answers are off. Play-style tracking still works.</span>'}
      <span class="muted">This month: about $${esc((coachInfo.spent || 0).toFixed(2))} of $${esc(Number(coachInfo.budget || 0).toFixed(2))}. Each member can ask ${esc(coachInfo.perDay || 30)} questions and make ${esc(coachInfo.plansPerDay || 5)} plans a day.</span></p>
    <form method="post" action="/settings/coach" class="inline-form">${csrfField(csrf)}
      <label class="check"><input type="checkbox" name="enabled"${coachInfo.enabled ? ' checked' : ''}> Coach AI on</label>
      <label>Monthly budget (USD)<input name="budget" type="number" min="0" max="500" step="1" value="${esc(coachInfo.budget ?? 15)}"></label>
      <button class="btn">Save</button></form>
  </section>
  <section class="setting">
    <h2>Realm and official Blizzard data</h2>
    <p>The site reads Blizzard's free game data: item names and stats, ${gameData.ns && gameData.ns.dynamic ? 'whether your realm is up (with a notification when it comes back), and the official guild list' : 'and, once Blizzard adds WoW: Forever to its API, your realm status and the official guild list'}.
      <span class="muted">Using: ${esc(gameData.ns ? gameData.ns.label : 'nothing yet')}. ${esc(gameData.items || 0)} items known.</span></p>
    ${guild.official_roster_note ? `<p class="muted">Official guild list: ${esc(guild.official_roster_note)}, ${ago(guild.official_roster_at)}.</p>` : ''}
    ${gameData.realmStatus && gameData.realmStatus.found === false ? `<p class="warn">Blizzard doesn't list a realm called “${esc(guild.realm)}” yet.</p>` : ''}
    <form method="post" action="/settings/realm" class="inline-form">${csrfField(csrf)}
      <label class="grow">Realm<input name="realm" maxlength="60" value="${esc(guild.realm || '')}" placeholder="Filled in by the addon"></label>
      <label class="grow">Guild name in game<input name="game_guild" maxlength="60" value="${esc(guild.game_guild || '')}" placeholder="wow"></label>
      <button class="btn">Save</button></form>
    <form method="post" action="/settings/gamedata/refresh">${csrfField(csrf)}<button class="btn btn-small btn-quiet">Refresh now</button></form>
  </section>
  <section class="setting">
    <h2>Members</h2>
    <ul class="tokens">${members.map((m) => `<li>${esc(m.battletag)} <span class="pill">${esc(m.role)}</span>
      ${m.role === 'member' ? memberAction(m.id, 'promote', 'Make officer', csrf) : ''}
      ${m.role === 'officer' && isOwner ? memberAction(m.id, 'demote', 'Make member', csrf) : ''}
      ${m.role !== 'owner' && m.id !== me && (m.role === 'member' || isOwner) ? memberAction(m.id, 'remove', 'Remove', csrf, `Remove ${m.battletag} from the guild? Their sync keys stop working.`) : ''}</li>`).join('')}</ul>
    <form method="post" action="/settings/invite/reset">${csrfField(csrf)}<button class="btn btn-small btn-quiet" data-confirm="Make a new invite link? The current one will stop working.">Replace invite link</button></form>
  </section>` : ''}`;
}

function downloads({ addon, companion, baseUrl, signedIn, csrf }) {
  return `<section class="downloads">
    <h1>Get the guild tools</h1>
    <p class="lede">Two small downloads connect your game to the guild site: the addon (inside WoW) and the companion (on your PC, carries the data).</p>
    <ol class="steps big-steps">
      <li><h2>The addon</h2>
        ${addon ? `<p><a class="btn btn-primary" href="/downloads/WowGuild.zip" download>Download WowGuild ${esc(addon.version || '')}</a> <span class="muted">${esc(addon.mb)}</span></p>` : '<p class="muted">Not available on this server yet.</p>'}
        <p>Unzip it into your game's <code>Interface\\AddOns</code> folder, so you end up with <code>Interface\\AddOns\\WowGuild</code>.
          For Forever that's inside <code>World of Warcraft\\_forever_</code>; for Retail, <code>_retail_</code>.</p></li>
      <li><h2>The companion</h2>
        ${!companion ? '<p class="muted">Not available on this server yet.</p>' : signedIn
          ? `<form method="post" action="/settings/companion"><input type="hidden" name="_csrf" value="${esc(csrf)}">
              <button class="btn btn-primary">Download companion ${esc(companion.version || '')}, ready to go</button> <span class="muted">${esc(companion.mb)}, Windows</span></form>
            <p>It comes with <code>config.json</code> already filled in: this site's address and a new sync key that's yours alone. Unzip both files into any folder and run <code>wow-companion.exe</code>.</p>`
          : `<p><a class="btn btn-primary" href="/downloads/wow-companion.zip" download>Download companion ${esc(companion.version || '')}</a> <span class="muted">${esc(companion.mb)}, Windows</span></p>
            <p>Comes with <code>config.json</code> already pointing at this site. <a href="/">Sign in</a> first and this button gives you a version with your sync key filled in too.</p>`}
        <p class="muted">Windows may warn the first time because the app isn't code-signed: choose <em>More info → Run anyway</em>.</p></li>
      <li><h2>Play</h2>
        <p>Leave the companion open while you play. In game, click the campfire on the minimap. On the Camp tab, <strong>Sync now</strong> sends everything to the site.</p></li>
    </ol>
  </section>`;
}

function semverLess(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
}

function admin({ latest, isOwner, members, backups, auditRows, blizzard, csrf }) {
  const stale = (iso) => !iso || Date.now() - new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime() > 7 * 86400000;
  const ver = (v, newest) => (!v ? '<span class="muted">not yet</span>' : semverLess(v, newest) ? `<span class="warn">${esc(v)}</span>` : esc(v));
  return `<h1>Officer tools</h1>
  <section class="setting">
    <h2>Sync health</h2>
    <p class="muted">Latest versions: addon ${esc(latest.addon || '?')}, companion ${esc(latest.companion || '?')}. Red means outdated, so point them to the downloads page. Grey rows haven't synced for a week.</p>
    <div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th class="num">Characters</th><th>Last sync</th><th>Addon</th><th>Companion</th><th>Discord</th></tr></thead><tbody>
      ${members.map((m) => `<tr${stale(m.last_sync_at) ? ' class="is-stale-row"' : ''}><td>${esc(m.battletag)}</td><td>${esc(m.role)}</td><td class="num">${m.chars}</td>
        <td>${m.last_sync_at ? ago(m.last_sync_at) : `<span class="warn">never</span>${m.keys ? '' : ' <span class="muted">(no sync key)</span>'}`}</td>
        <td>${ver(m.addon_version, latest.addon)}</td><td>${ver(m.companion_version, latest.companion)}</td><td>${m.discord_id ? 'linked' : '<span class="muted">no</span>'}</td></tr>`).join('')}
    </tbody></table></div>
  </section>
  <section class="setting">
    <h2>Blizzard game data</h2>
    ${blizzard ? `<p>${blizzard.ok ? 'Your Battle.net app can read Blizzard’s free game data.' : '<span class="warn">Blizzard’s game data isn’t reachable with your Battle.net app.</span>'}
      ${blizzard.forever ? ` <strong>WoW: Forever data is available</strong> (${esc(blizzard.forever)}).` : ' WoW: Forever isn’t in Blizzard’s API yet. This is checked daily, and it shows here when it arrives.'}
      ${blizzard.tokenGold ? ` Retail WoW Token (${esc(blizzard.region.toUpperCase())}): ${esc(blizzard.tokenGold.toLocaleString('en'))}g.` : ''}
      <span class="muted">Checked ${ago(blizzard.checkedAt)}.</span></p>` : '<p class="muted">Not checked yet. The server checks shortly after it starts.</p>'}
    <form method="post" action="/admin/blizzard"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="btn btn-small">Check now</button></form>
  </section>
  <section class="setting">
    <h2>Backups</h2>
    <p class="muted">The database is copied every day and the last 14 copies are kept on the server. ${isOwner ? 'As owner you can download them.' : 'The guild owner can download them.'}</p>
    <ul class="board">${backups.slice(0, 14).map((b) => `<li>${isOwner ? `<a href="/admin/backups/${encodeURIComponent(b.file)}">${esc(b.file)}</a>` : esc(b.file)} <span class="muted">${Math.max(1, Math.round(b.bytes / 1024))} KB, ${ago(b.at)}</span></li>`).join('') || '<li class="empty">No backups yet. The first one runs shortly after the server starts.</li>'}</ul>
  </section>
  ${isOwner ? `<section class="setting officer-box">
    <h2>Fresh start</h2>
    <p>Wipes all game data: characters, roster, raids and loot, bank, prices, drives, requests, calls to arms and activity.
      Members, roles, settings, sync keys, the invite link and notifications stay. A backup is made first.
      Data from before the wipe is ignored if an old game folder (for example Retail testing) uploads it again.</p>
    <form method="post" action="/admin/reset" class="inline-form"><input type="hidden" name="_csrf" value="${esc(csrf)}">
      <label class="grow">Type WIPE to confirm<input name="confirm" autocomplete="off" required pattern="[Ww][Ii][Pp][Ee]"></label>
      <button class="btn btn-alarm" data-confirm="Wipe all of the guild's game data? A backup is kept.">Wipe game data</button></form>
  </section>` : ''}
  <section class="setting">
    <h2>Audit log</h2>
    <p class="muted">Officer and account actions, newest first.</p>
    <ul class="board">${auditRows.map((a) => `<li><strong>${esc((a.battletag || 'system').split('#')[0])}</strong> ${esc(a.action)}${a.detail ? `: ${esc(a.detail)}` : ''} <span class="muted">${ago(a.created_at)}</span></li>`).join('') || '<li class="empty">Nothing yet.</li>'}</ul>
  </section>`;
}

function notFound() {
  return '<h1>Nothing here</h1><p>That page doesn’t exist. <a href="/">Back to camp</a>.</p>';
}

module.exports = { admin, semverLess, downloads, landing, setup, home, roster, character, crafters, requests, buddies, settings, notFound };
