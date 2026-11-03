const { esc, classInfo, ago, when } = require('./layout');
const { itemLink, itemHover } = require('./wowhead');

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const ROLE_LABEL = { tank: 'Tanks', healer: 'Healers', dps: 'Damage' };
const STATUS_LABEL = { yes: 'Coming', tentative: 'Maybe', bench: 'Bench', no: 'Can’t make it' };
const KIND_LABEL = { raid: 'Raid', pvp: 'PvP', event: 'Event' };
const RAID_STATUS = { open: 'Reserves open', locked: 'Reserves locked', done: 'Finished', cancelled: 'Cancelled' };

function cname(name, cls) {
  const [label, color] = classInfo(cls);
  return `<a class="clink" href="/characters/${encodeURIComponent(name)}" title="${esc(label)}"><span class="cname" style="--cc:${color}">${esc(name)}</span></a>`;
}

function readiness(r) {
  if (!r) return '<span class="muted">no data</span>';
  const bits = [];
  if (r.ilvl) bits.push(`ilvl ${Math.round(r.ilvl)}`);
  if (r.durability != null) bits.push(`<span class="${r.durability < 30 ? 'warn' : ''}">${Math.round(r.durability)}% repair</span>`);
  const c = r.consumables || {};
  const total = Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0);
  bits.push(total ? Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${esc(k)}`).join(', ') : '<span class="warn">no consumables</span>');
  return `${bits.join(' · ')} <span class="muted">(${ago(r.at ? new Date(r.at * 1000).toISOString() : null)})</span>`;
}

function roleCounts(signups) {
  const c = { tank: 0, healer: 0, dps: 0 };
  for (const s of signups) if (s.status === 'yes') c[s.role] += 1;
  return c;
}

// ---------- list ----------

function raidsList({ csrf, upcoming, past, isOfficer, instances, mine }) {
  const row = (r) => `<li class="raid-row">
      <div class="raid-when">${when(r.starts_at)}</div>
      <div class="raid-main"><a href="/raids/${r.id}" class="raid-title">${esc(r.title)}</a>${r.kind && r.kind !== 'raid' ? ` <span class="pill kind-${esc(r.kind)}">${KIND_LABEL[r.kind]}</span>` : ''}
        <span class="muted">${esc(r.instance)}${r.size ? `, ${esc(r.size)} players` : ''}</span></div>
      <div class="raid-counts" aria-label="Signed up">${r.tanks}<small> tank${r.tanks === 1 ? '' : 's'}</small> ${r.healers}<small> heal</small> ${r.dps}<small> dps</small></div>
      <div>${mine[r.id] ? `<span class="pill">${esc(STATUS_LABEL[mine[r.id]])}</span>` : r.status === 'cancelled' ? '<span class="pill">Cancelled</span>' : '<span class="muted">Not signed up</span>'}</div>
    </li>`;
  return `<h1>Raids</h1>
  ${isOfficer ? `<details class="officer-box"${upcoming.length ? '' : ' open'}><summary>Schedule a raid</summary>
    <form method="post" action="/raids" class="grid-form">${csrfField(csrf)}<input type="hidden" name="tz_offset" value="">
      <label>Type<select name="kind"><option value="raid">Raid (with reserves)</option><option value="pvp">PvP premade</option><option value="event">Guild event</option></select></label>
      <label>Name<input name="title" required maxlength="60" placeholder="Hyjal Summit, week 1"></label>
      <label>Instance or place<input name="instance" required maxlength="60" list="instances" placeholder="Hyjal Summit"></label>
      <datalist id="instances">${instances.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>
      <label>Starts<input name="starts" type="datetime-local" required></label>
      <label>Players<input name="size" type="number" min="5" max="40" placeholder="20"></label>
      <label>Reserves each<input name="sr_limit" type="number" min="0" max="5" value="2"></label>
      <label class="wide">Notes<input name="notes" maxlength="300" placeholder="Bring fire resistance"></label>
      <button class="btn btn-primary">Schedule raid</button>
    </form>
    <p class="hint">Times are entered in your own time zone. Everyone sees them in theirs. Posting to Discord happens straight away, plus a reminder an hour before.</p>
  </details>` : ''}
  <h2>Coming up</h2>
  <ul class="raid-list">${upcoming.map(row).join('') || '<li class="empty">Nothing scheduled yet.</li>'}</ul>
  ${past.length ? `<h2>Recent</h2><ul class="raid-list">${past.map(row).join('')}</ul>` : ''}`;
}

// ---------- single raid ----------

function raidPage({ raid, csrf, signups, mySignup, myChars, items, myReserves, board, isOfficer, loot }) {
  const counts = roleCounts(signups);
  const canSign = raid.status === 'open' || raid.status === 'locked';
  const reservedIds = new Set(myReserves.map((r) => r.id));
  const byBoss = {};
  for (const it of items) (byBoss[it.boss || 'Trash and other'] ||= []).push(it);
  const boardCount = Object.fromEntries(board.map((b) => [b.item_id, b.reservers.length]));
  const attending = signups.filter((s) => s.status === 'yes' || s.status === 'bench');

  return `<p class="crumb"><a href="/raids">Raids</a></p>
  <h1>${esc(raid.title)}</h1>
  <p class="lede">${when(raid.starts_at)} · ${esc(raid.instance)}${raid.size ? ` · ${esc(raid.size)} players` : ''} · <span class="pill">${raid.kind && raid.kind !== 'raid' ? `${KIND_LABEL[raid.kind]} · ` : ''}${RAID_STATUS[raid.status]}</span></p>
  ${raid.notes ? `<p>${esc(raid.notes)}</p>` : ''}

  ${canSign ? `<section class="setting">
    <h2>${mySignup ? 'Your sign-up' : 'Sign up'}</h2>
    <form method="post" action="/raids/${raid.id}/signup" class="req-form">${csrfField(csrf)}
      <label>Character${myChars.length ? `<select name="character">${myChars.map((c) => `<option${mySignup && mySignup.character === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
        : `<input name="character" required maxlength="40" value="${esc(mySignup ? mySignup.character : '')}">`}</label>
      <label>Role<select name="role">${['tank', 'healer', 'dps'].map((r) => `<option value="${r}"${mySignup && mySignup.role === r ? ' selected' : ''}>${r === 'dps' ? 'Damage' : r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select></label>
      <label>Coming?<select name="status">${['yes', 'tentative', 'no'].map((s) => `<option value="${s}"${mySignup && mySignup.status === s ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
      <label class="grow">Note<input name="note" maxlength="120" value="${esc(mySignup ? mySignup.note || '' : '')}" placeholder="Might be 15 min late"></label>
      <button class="btn btn-primary">${mySignup ? 'Update sign-up' : 'Sign up'}</button>
    </form>
  </section>` : ''}

  ${raid.kind && raid.kind !== 'raid' ? '' : `<section class="setting">
    <h2>Soft reserves</h2>
    ${!items.length ? `<p class="empty">No loot list for ${esc(raid.instance)} yet. ${isOfficer ? `<a href="/loot?instance=${encodeURIComponent(raid.instance)}">Add the items</a> so people can reserve.` : 'An officer needs to add it.'}</p>`
      : raid.sr_limit === 0 ? '<p class="muted">This raid has no reserves. Everything is open roll.</p>'
      : `<p class="muted">Pick up to ${raid.sr_limit}. Your bonus grows by +10 every raid you attend with the same item reserved, and resets when you win it.</p>
    <form method="post" action="/raids/${raid.id}/reserves">${csrfField(csrf)}
      <div class="loot-grid">${Object.entries(byBoss).map(([boss, list]) => `<fieldset><legend>${esc(boss)}</legend>
        ${list.map((it) => `<label class="check"><input type="checkbox" name="item" value="${it.id}"${reservedIds.has(it.id) ? ' checked' : ''}${raid.status !== 'open' ? ' disabled' : ''}>
          <span>${itemHover(it.wh_id, it.name)}</span>${it.bonus ? `<span class="pill bonus">+${it.bonus}</span>` : ''}${boardCount[it.id] ? `<span class="muted"> ${boardCount[it.id]} reserved</span>` : ''}</label>`).join('')}
      </fieldset>`).join('')}</div>
      ${raid.status === 'open' ? '<button class="btn btn-primary">Save reserves</button>' : '<p class="muted">Reserves are locked.</p>'}
    </form>`}
  </section>`}

  <section class="setting">
    <h2>Who’s coming <span class="muted small">${counts.tank} tank${counts.tank === 1 ? '' : 's'}, ${counts.healer} healer${counts.healer === 1 ? '' : 's'}, ${counts.dps} damage</span></h2>
    ${['tank', 'healer', 'dps'].map((role) => {
      const list = signups.filter((s) => s.role === role && s.status !== 'no');
      return list.length ? `<h3>${ROLE_LABEL[role]}</h3><ul class="signups">${list.map((s) => `<li>
        ${cname(s.character, s.class)} ${s.status !== 'yes' ? `<span class="pill">${STATUS_LABEL[s.status]}</span>` : ''}
        ${s.note ? `<span class="muted">“${esc(s.note)}”</span>` : ''}
        <span class="ready">${readiness(s.ready)}</span></li>`).join('')}</ul>` : '';
    }).join('') || '<p class="empty">Nobody has signed up yet.</p>'}
    ${signups.some((s) => s.status === 'no') ? `<p class="muted">Can’t make it: ${signups.filter((s) => s.status === 'no').map((s) => esc(s.character)).join(', ')}</p>` : ''}
    <p class="hint">Readiness comes from the addon: item level, repair state and consumables in bags at their last reload.</p>
  </section>

  ${board.length ? `<section class="setting"><h2>Reserve list</h2>
    <ul class="board">${board.map((b) => `<li><strong>${itemLink(b.wh_id, b.item)}</strong> ${b.reservers.map((r) => `${esc(r.character || r.battletag.split('#')[0])}${r.bonus ? ` <span class="pill bonus">+${r.bonus}</span>` : ''}`).join(', ')}</li>`).join('')}</ul>
    <details><summary>Copy as text for raid chat</summary><textarea readonly rows="6" class="copybox">${esc(board.map((b) => `${b.item}: ${b.reservers.map((r) => `${r.character || r.battletag.split('#')[0]}${r.bonus ? ` (+${r.bonus})` : ''}`).join(', ')}`).join('\n'))}</textarea></details>
  </section>` : ''}

  ${loot.length ? `<section class="setting"><h2>Loot given out</h2><ul class="board">${loot.map((l) => `<li><strong>${itemLink(l.wh_id, l.item_name)}</strong> to ${esc(l.character || '?')} <span class="muted">${esc(l.kind.toUpperCase())}${l.roll != null ? `, rolled ${l.roll}${l.bonus ? ` + ${l.bonus}` : ''}` : ''}</span></li>`).join('')}</ul></section>` : ''}

  ${isOfficer ? `<section class="setting officer-box">
    <h2>Raid leader</h2>
    <div class="actions-row">
      ${raid.status !== 'done' && raid.status !== 'cancelled' ? `<a class="btn btn-primary" href="/raids/${raid.id}/loot">Open loot screen</a>` : ''}
      ${raid.status === 'open' ? officerAction(raid.id, 'lock', 'Lock reserves', csrf) : ''}
      ${raid.status === 'locked' ? officerAction(raid.id, 'unlock', 'Reopen reserves', csrf) : ''}
      ${raid.status === 'open' || raid.status === 'locked' ? officerAction(raid.id, 'cancel', 'Cancel raid', csrf, 'Cancel this raid? Everyone signed up will see it as cancelled.') : ''}
    </div>
    ${raid.status === 'open' || raid.status === 'locked' ? `<form method="post" action="/raids/${raid.id}/close" class="stack">${csrfField(csrf)}
      <h3>Close the raid</h3>
      <p class="muted">Tick who was there. Attending with a reserve adds +10 to that item’s bonus. Signing up “Coming” and not showing resets it.</p>
      <div class="attend">${attending.map((s) => `<label class="check"><input type="checkbox" name="attended" value="${s.user_id}" checked> ${esc(s.character)}</label>`).join('') || '<p class="empty">Nobody signed up.</p>'}</div>
      <button class="btn" data-confirm="Close the raid and update loyalty bonuses? This can’t be undone.">Close raid and update bonuses</button>
    </form>` : ''}
  </section>` : ''}`;
}
function officerAction(id, verb, label, csrf, confirm) {
  return `<form method="post" action="/raids/${id}/${verb}">${csrfField(csrf)}<button class="btn"${confirm ? ` data-confirm="${esc(confirm)}"` : ''}>${label}</button></form>`;
}

// ---------- leader's loot screen (phone first) ----------

function lootScreen({ raid, csrf, board, rolls, items, attending, awarded }) {
  return `<p class="crumb"><a href="/raids/${raid.id}">${esc(raid.title)}</a></p>
  <h1>Loot</h1>
  <p class="muted">Tap Roll when a reserved item drops. Rolls are 1–100 plus each player's bonus, done here so everyone can see them.</p>
  <ul class="loot-live">${board.map((b) => {
    const r = rolls[b.item_id] || [];
    return `<li class="loot-card" id="item-${b.item_id}">
      <div class="loot-head"><strong>${itemLink(b.wh_id, b.item)}</strong>${b.boss ? ` <span class="muted">${esc(b.boss)}</span>` : ''}</div>
      <p class="muted">${b.reservers.map((x) => `${esc(x.character || x.battletag.split('#')[0])}${x.bonus ? ` +${x.bonus}` : ''}${x.signup !== 'yes' && x.signup !== 'bench' ? ' (not in raid)' : ''}`).join(', ')}</p>
      ${r.length ? `<ol class="rolls">${r.map((x, i) => `<li${i === 0 ? ' class="top"' : ''}><span>${esc(x.character || x.battletag.split('#')[0])}</span>
          <span class="muted">${x.roll}${x.bonus ? ` + ${x.bonus}` : ''} =</span> <strong>${x.total}</strong>
          <form method="post" action="/raids/${raid.id}/award">${csrfField(csrf)}<input type="hidden" name="item_id" value="${b.item_id}"><input type="hidden" name="user_id" value="${x.user_id}"><input type="hidden" name="kind" value="sr">
          <button class="btn btn-small${i === 0 ? ' btn-primary' : ''}">Give</button></form></li>`).join('')}</ol>` : ''}
      <form method="post" action="/raids/${raid.id}/roll">${csrfField(csrf)}<input type="hidden" name="item_id" value="${b.item_id}">
        <button class="btn${r.length ? '' : ' btn-primary'}">${r.length ? 'Roll again' : 'Roll'}</button></form>
    </li>`;
  }).join('') || '<li class="empty">No reserved items left. Everything else is open roll: record it below.</li>'}</ul>

  <section class="setting">
    <h2>Give an item without reserves</h2>
    <form method="post" action="/raids/${raid.id}/award" class="grid-form">${csrfField(csrf)}
      <label>Item<input name="item_name" list="raid-items" required maxlength="100"></label>
      <datalist id="raid-items">${items.map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>
      <label>To<select name="user_id">${attending.map((s) => `<option value="${s.user_id}">${esc(s.character)}</option>`).join('')}</select></label>
      <label>Type<select name="kind"><option value="ms">Main spec</option><option value="os">Off spec</option><option value="free">Free roll</option></select></label>
      <button class="btn">Record</button>
    </form>
  </section>
  ${awarded.length ? `<h2>Given out tonight</h2><ul class="board">${awarded.map((l) => `<li><strong>${itemLink(l.wh_id, l.item_name)}</strong> to ${esc(l.character || '?')} <span class="muted">${esc(l.kind.toUpperCase())}</span></li>`).join('')}</ul>` : ''}`;
}

// ---------- loot catalogue, bonuses, history ----------

function lootPage({ csrf, isOfficer, catalog, focus, history, myLoyalty }) {
  const instances = Object.keys(catalog);
  return `<h1>Loot</h1>
  <section class="setting">
    <h2>Your reserve bonuses</h2>
    ${myLoyalty.length ? `<ul class="board">${myLoyalty.map((l) => `<li>${esc(l.name)} <span class="muted">${esc(l.instance)}</span> <span class="pill bonus">+${l.bonus}</span></li>`).join('')}</ul>`
      : '<p class="muted">None yet. Reserve an item and attend: each raid adds +10 until you win it.</p>'}
  </section>
  <section class="setting">
    <h2>Loot lists</h2>
    ${instances.length ? instances.map((inst) => `<details${inst === focus ? ' open' : ''}><summary>${esc(inst)} <span class="muted">(${catalog[inst].length} items)</span></summary>
      <ul class="cols-list">${catalog[inst].map((i) => `<li>${itemLink(i.wh_id, i.name)}${i.boss ? ` <span class="muted">${esc(i.boss)}</span>` : ''}${isOfficer ? ` <form class="inline" method="post" action="/loot/items/${i.id}/delete">${csrfField(csrf)}<button class="link-btn danger" aria-label="Remove ${esc(i.name)}">remove</button></form>` : ''}</li>`).join('')}</ul></details>`).join('')
      : '<p class="empty">No loot lists yet.</p>'}
    ${isOfficer ? `<form method="post" action="/loot/items" class="stack narrow-wide">${csrfField(csrf)}
      <h3>Add items</h3>
      <label>Instance<input name="instance" required maxlength="60" list="inst-list" value="${esc(focus || '')}" placeholder="Hyjal Summit"></label>
      <datalist id="inst-list">${instances.map((i) => `<option value="${esc(i)}">`).join('')}</datalist>
      <label><span>One item per line. Put the boss first if you like: <code>Boss | Item</code>. Add <code>| 12345</code> or a Wowhead link at the end for hover tooltips.</span><textarea name="items" rows="6" required placeholder="Rage Winterchill | Frostbound Greaves&#10;Anetheron | Cloak of the Long Night"></textarea></label>
      <button class="btn btn-primary">Add items</button>
    </form>` : ''}
  </section>
  <section class="setting">
    <h2>Loot history</h2>
    ${history.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>To</th><th>How</th><th>Raid</th><th>When</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td>${itemLink(h.wh_id, h.item_name)}</td><td>${esc(h.character || '')}</td><td>${esc(h.kind.toUpperCase())}${h.roll != null ? ` <span class="muted">${h.roll}${h.bonus ? `+${h.bonus}` : ''}</span>` : ''}</td>
        <td>${h.raid_id ? `<a href="/raids/${h.raid_id}">${esc(h.title || '')}</a>` : ''}</td><td class="muted">${ago(h.created_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">Nothing handed out yet.</p>'}
  </section>`;
}

module.exports = { raidsList, raidPage, lootScreen, lootPage, roleCounts };
