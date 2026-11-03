const { esc, classInfo, ago } = require('./layout');

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

function home({ csrf, online, scannedAt, ctas, announcements, activity, isOfficer, mySync }) {
  return `${campRing(online, scannedAt)}
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

function roster({ chars, scannedAt }) {
  const rows = chars.map((c) => {
    const [label] = classInfo(c.class);
    return `<tr${c.online ? ' class="is-online"' : ''}>
      <td>${c.online ? '<span class="dot" title="Online"></span>' : ''}${charName(c)}${c.is_main ? ' <span class="pill">main</span>' : ''}</td>
      <td>${esc(c.level ?? '')}</td><td>${esc(label)}</td><td>${esc(c.rank || '')}</td>
      <td>${esc(c.zone || '')}</td><td>${esc(c.battletag ? c.battletag.split('#')[0] : '')}</td>
      <td class="muted">${c.online ? 'now' : ago(c.last_seen)}</td></tr>`;
  }).join('');
  return `<h1>Roster</h1>
  <p class="muted">${chars.length} characters. Roster as of ${ago(scannedAt)}. A player name means that member has linked the character with the companion.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Level</th><th>Class</th><th>Rank</th><th>Zone</th><th>Player</th><th>Seen</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No characters yet. The roster fills in after the first sync.</td></tr>'}</tbody>
  </table></div>`;
}

function character({ c, profs, recipes, csrf, isOwner, alts }) {
  const [label, color] = classInfo(c.class);
  const byProf = {};
  for (const r of recipes) (byProf[r.profession] ||= []).push(r.name);
  return `<p class="crumb"><a href="/roster">Roster</a></p>
  <h1 class="char-h" style="--cc:${color}">${esc(c.name)}</h1>
  <p class="lede">Level ${esc(c.level ?? '?')} ${esc(c.race || '')} ${esc(label)}${c.zone ? `, last in ${esc(c.zone)}` : ''}${c.rank ? `. ${esc(c.rank)}` : ''}.</p>
  ${isOwner && !c.is_main ? `<form method="post" action="/characters/${encodeURIComponent(c.name)}/main">${csrfField(csrf)}<button class="btn">Make this my main</button></form>` : ''}
  ${alts.length ? `<p>Same player: ${alts.map((a) => charName(a)).join(', ')}</p>` : ''}
  <h2>Professions</h2>
  ${profs.length ? `<ul class="profs">${profs.map((p) => `<li><strong>${esc(p.name)}</strong>
     <span class="bar" role="img" aria-label="${esc(p.skill)} of ${esc(p.max_skill)}"><span style="width:${Math.min(100, (p.skill / (p.max_skill || 300)) * 100)}%"></span></span>
     <span class="muted">${esc(p.skill)} / ${esc(p.max_skill)}</span></li>`).join('')}</ul>`
    : '<p class="empty">No professions synced. Open each profession window once in game, then reload.</p>'}
  ${Object.entries(byProf).map(([p, names]) => `<details class="recipes"><summary>${esc(p)} recipes (${names.length})</summary>
     <ul class="cols-list">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>`).join('')}`;
}

// ---------- Crafters ----------

function crafters({ q, results, profSummary }) {
  return `<h1>Crafters</h1>
  <form method="get" action="/crafters" class="search" role="search">
    <label class="sr" for="q">Search recipes</label>
    <input id="q" name="q" value="${esc(q)}" placeholder="Search a recipe, e.g. Heavy Silk Bandage" autofocus>
    <button class="btn">Search</button>
  </form>
  ${q ? `<h2>${results.length ? `Who can make “${esc(q)}”` : `Nobody has a recipe matching “${esc(q)}”`}</h2>
    ${results.length ? `<ul class="results">${results.map((r) => `<li>
      <span class="r-name">${esc(r.recipe)}</span>
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

function settings({ csrf, tokens, newToken, guild, baseUrl, isOfficer, members, discordInfo = {} }) {
  return `<h1>Settings</h1>
  <section class="setting">
    <h2>Connect the game</h2>
    <ol class="steps">
      <li>Copy the <code>WowGuild</code> folder into <code>World of Warcraft\\_forever_\\Interface\\AddOns</code>. The folder name may differ: use whichever one holds Forever.</li>
      <li>Put <code>wow-companion.exe</code> in any folder and run it once. It creates <code>config.json</code> next to itself.</li>
      <li>Create a sync key below. In <code>config.json</code>, set <code>syncKey</code> to it and <code>siteUrl</code> to <code>${esc(baseUrl)}</code>.</li>
      <li>Run the companion again and leave it open while you play. It uploads every time you log out or type <code>/reload</code>.</li>
    </ol>
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
    <h2>Discord commands</h2>
    ${discordInfo.configured ? `<p>Use <code>/online</code>, <code>/raids</code>, <code>/craft</code>, <code>/price</code>, <code>/cta</code> and <code>/signup</code> straight from Discord.
      ${discordInfo.linked ? 'Your Discord is linked.' : 'Link your Discord once so <code>/signup</code> and <code>/cta</code> know who you are.'}</p>
      <div class="actions-row">
        <form method="post" action="/settings/discord/link">${csrfField(csrf)}<button class="btn${discordInfo.linked ? '' : ' btn-primary'}">${discordInfo.linked ? 'Get a new link code' : 'Link Discord'}</button></form>
        ${discordInfo.linked ? `<form method="post" action="/settings/discord/unlink">${csrfField(csrf)}<button class="btn btn-quiet">Unlink</button></form>` : ''}
      </div>
      ${isOfficer ? `<div class="officer-box">
        <p>${discordInfo.serverLinked ? 'Your Discord server is connected.' : 'The server connects automatically the first time someone runs <code>/link</code> in it.'}
        To add the commands to your server, <a href="https://discord.com/oauth2/authorize?client_id=${esc(discordInfo.appId)}&amp;scope=applications.commands" target="_blank" rel="noopener">invite the app</a>, then register them.</p>
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
    <h2>Members</h2>
    <ul class="tokens">${members.map((m) => `<li>${esc(m.battletag)} <span class="pill">${esc(m.role)}</span>
      ${m.role === 'member' ? `<form method="post" action="/members/${m.id}/promote">${csrfField(csrf)}<button class="btn btn-small btn-quiet">Make officer</button></form>` : ''}</li>`).join('')}</ul>
  </section>` : ''}`;
}

function notFound() {
  return '<h1>Nothing here</h1><p>That page doesn’t exist. <a href="/">Back to camp</a>.</p>';
}

module.exports = { landing, setup, home, roster, character, crafters, requests, buddies, settings, notFound };
