const { esc, ago } = require('./layout');
const { money } = require('../economy');

const csrfField = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
const { itemLink } = require('./wowhead');
const coins = (c) => (c == null ? '<span class="muted">no price</span>' : `<span class="coins">${esc(money(c))}</span>`);

// ---------- Bank ----------

function itemTable(rows, { showWho } = {}) {
  let total = 0;
  const body = rows.map((r) => {
    const value = r.unit != null ? r.unit * r.count : null;
    if (value) total += value;
    return `<tr>${showWho ? `<td>${esc(r.character)}</td>` : ''}<td>${itemLink(r.item_id, r.name)}</td>
      <td class="num">${esc(r.count)}</td><td class="num">${coins(r.unit)}</td><td class="num">${value != null ? coins(value) : ''}</td></tr>`;
  }).join('');
  return { total, html: `<div class="table-wrap"><table><thead><tr>${showWho ? '<th>Character</th>' : ''}<th>Item</th><th class="num">Count</th><th class="num">Each</th><th class="num">Value</th></tr></thead><tbody>${body}</tbody></table></div>` };
}

function bankPage({ csrf, isOfficer, userId, guild, guildBank, alts, bankChars, requests, log, find, mine }) {
  const tabs = {};
  for (const r of guildBank) (tabs[r.tab] ||= []).push(r);
  let worth = 0;
  const tabHtml = Object.entries(tabs).map(([tab, rows]) => {
    const t = itemTable(rows); worth += t.total;
    return `<details><summary>${esc(tab)} <span class="muted">(${rows.length} kinds of item)</span></summary>${t.html}</details>`;
  }).join('');
  const altTable = alts.length ? itemTable(alts, { showWho: true }) : null;
  if (altTable) worth += altTable.total;
  const open = requests.filter((r) => r.status === 'open');
  const done = requests.filter((r) => r.status !== 'open');

  return `<h1>Bank</h1>
  <p class="lede">${guild.bank_money != null || alts.length || guildBank.length
    ? `${guild.bank_money != null ? `Guild bank gold: ${coins(guild.bank_money)}. ` : ''}Items worth about ${coins(worth)} at recent auction prices.`
    : 'Nothing synced yet. Open the guild bank in game (or mark a bank character below), then reload.'}</p>

  <section class="setting">
    <h2>Ask the bank for something</h2>
    <form method="post" action="/bank/requests" class="req-form">${csrfField(csrf)}
      <label class="grow">Item<input name="item" required maxlength="100" placeholder="Heavy Runecloth Bandage"></label>
      <label>How many<input name="count" type="number" min="1" max="1000" value="1"></label>
      <label class="grow">Why<input name="note" maxlength="200" placeholder="For raid on Thursday"></label>
      <button class="btn btn-primary">Send request</button>
    </form>
    <ul class="reqs">${open.map((r) => `<li class="req"><div><strong>${esc(r.count)} × ${esc(r.item)}</strong>${r.note ? `<p>${esc(r.note)}</p>` : ''}
        <span class="muted">for ${esc(r.requester.split('#')[0])}, ${ago(r.created_at)}</span></div>
        <div class="req-actions">
          ${isOfficer ? `${act(r.id, 'sent', 'Mark as sent', csrf, true)}${act(r.id, 'declined', 'Decline', csrf)}` : ''}
          ${r.requester_id === userId ? act(r.id, 'cancel', 'Cancel', csrf) : ''}
        </div></li>`).join('') || '<li class="empty">No open requests.</li>'}</ul>
    ${done.length ? `<details><summary>Handled this week (${done.length})</summary><ul class="board">${done.map((r) => `<li>${esc(r.count)} × ${esc(r.item)} for ${esc(r.requester.split('#')[0])}
      <span class="muted">${r.status === 'sent' ? 'sent' : 'declined'} by ${esc((r.handler || '').split('#')[0])}, ${ago(r.updated_at)}</span></li>`).join('')}</ul></details>` : ''}
  </section>

  <section class="setting">
    <h2>Find something on your own characters</h2>
    <form method="get" action="/bank" class="search" role="search">
      <label class="sr" for="find">Item name</label>
      <input id="find" name="find" value="${esc(find)}" placeholder="Which alt has my Runecloth?">
      <button class="btn">Find</button>
    </form>
    ${mine ? (mine.length ? `<ul class="board">${mine.map((m) => `<li><strong>${itemLink(m.item_id, m.name)}</strong> × ${esc(m.count)} <span class="muted">on ${esc(m.character)}, in ${m.location === 'bank' ? 'the bank' : 'bags'}</span></li>`).join('')}</ul>`
      : `<p class="empty">None of your synced characters carry “${esc(find)}”. Bank contents update when you open the bank in game.</p>`) : ''}
  </section>

  ${tabHtml ? `<section class="setting"><h2>Guild bank</h2><p class="muted">As of ${ago(guild.bank_scanned_at)}. Anyone opening the guild bank with the addon updates it.</p>${tabHtml}</section>` : ''}
  ${altTable ? `<section class="setting"><h2>Bank characters</h2>${altTable.html}</section>` : ''}

  ${log.length ? `<section class="setting"><h2>Guild bank log</h2><ul class="board">${log.map((l) => `<li>${esc(l.who || 'Someone')}
    ${esc(l.kind)}${l.name ? ` ${l.count ? `${esc(l.count)} × ` : ''}${esc(l.name)}` : ''}${l.amount ? ` ${coins(l.amount)}` : ''} <span class="muted">about ${ago(l.at)}</span></li>`).join('')}</ul></section>` : ''}

  ${isOfficer ? `<section class="setting officer-box"><h2>Bank characters</h2>
    <p class="muted">No guild bank? Mark the characters that hold guild stock. Their bags and bank appear above once their owner syncs.</p>
    <form method="post" action="/bank/alts" class="inline-form">${csrfField(csrf)}
      <label class="sr" for="bc">Character</label>
      <select id="bc" name="character">${bankChars.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}${c.is_bank ? ' (bank, click to remove)' : ''}</option>`).join('')}</select>
      <button class="btn">Toggle bank character</button></form></section>` : ''}`;
}
function act(id, verb, label, csrf, primary) {
  return `<form method="post" action="/bank/requests/${id}/${verb}">${csrfField(csrf)}<button class="btn btn-small${primary ? ' btn-primary' : ' btn-quiet'}">${label}</button></form>`;
}

// ---------- Prices ----------

function spark(history) {
  if (history.length < 2) return '';
  const w = 120; const h = 28;
  const ps = history.map((x) => x.price);
  const lo = Math.min(...ps); const hi = Math.max(...ps);
  const pts = ps.map((p, i) => `${((i / (ps.length - 1)) * w).toFixed(1)},${(h - 2 - ((p - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Price over the last ${history.length} scan days, from ${esc(money(ps[0]))} to ${esc(money(ps[ps.length - 1]))}"><polyline points="${pts}"/></svg>`;
}

function pricesPage({ q, results, stats, held }) {
  return `<h1>Prices</h1>
  <p class="lede">${stats.items ? `${stats.items.toLocaleString('en')} items priced from guild Auctionator scans, newest from ${esc(stats.newest)}.`
    : 'No prices yet. Anyone running Auctionator and the companion adds their scans here automatically.'}</p>
  <form method="get" action="/prices" class="search" role="search">
    <label class="sr" for="pq">Item</label>
    <input id="pq" name="q" value="${esc(q)}" placeholder="Search an item, e.g. Runecloth">
    <button class="btn">Search</button>
  </form>
  ${q ? (results.length ? priceTable(results) : `<p class="empty">No scanned item matches “${esc(q)}”. Item names are learned from what members carry, so very rare items may only show by number.</p>`)
    : held.length ? `<h2>What the guild holds</h2><p class="muted">Items in members’ bags and the guild bank that have recent auction prices.</p>${priceTable(held)}` : ''}`;
}
function priceTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Latest</th><th>Scanned</th><th>Last 2 weeks</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${itemLink(r.item_id, r.name)}</td>
      <td class="num">${r.latest ? coins(r.latest.price) : ''}</td><td class="muted">${r.latest ? esc(r.latest.day) : ''}</td><td>${spark(r.history || [])}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- Supply drives ----------

function drivesPage({ csrf, isOfficer, open, past, byDrive, myChars }) {
  const card = (d) => {
    const pct = Math.min(100, Math.round((d.total / d.goal) * 100));
    const board = byDrive[d.id] || [];
    return `<li class="drive">
      <div class="drive-head"><h2>${esc(d.title)}</h2><span class="muted">${esc(d.total.toLocaleString('en'))} of ${esc(d.goal.toLocaleString('en'))} ${esc(d.unit)}</span></div>
      ${d.notes ? `<p>${esc(d.notes)}</p>` : ''}
      <div class="bar big" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${pct}% of goal"><span style="width:${pct}%"></span></div>
      ${d.status === 'open' ? `<form method="post" action="/drives/${d.id}/give" class="req-form">${csrfField(csrf)}
        <label>Handed in<input name="amount" type="number" min="1" required placeholder="10"></label>
        <label>Character${myChars.length ? `<select name="character">${myChars.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select>` : '<input name="character" maxlength="40">'}</label>
        <label class="grow">Note<input name="note" maxlength="120" placeholder="Optional"></label>
        <button class="btn btn-primary">Log it</button>
      </form>` : `<p><span class="pill">${d.status === 'done' ? 'Goal reached' : 'Closed'}</span></p>`}
      ${board.length ? `<ol class="leaders">${board.slice(0, 10).map((b) => `<li><span>${esc(String(b.who).split('#')[0])}</span><strong>${esc(b.amount.toLocaleString('en'))}</strong></li>`).join('')}</ol>` : ''}
      ${isOfficer && d.status === 'open' ? `<form method="post" action="/drives/${d.id}/close">${csrfField(csrf)}<button class="btn btn-small btn-quiet">Close drive</button></form>` : ''}
    </li>`;
  };
  return `<h1>Supply drives</h1>
  <p class="lede">Pool effort toward a shared goal: loot crates for faction rep, mats for raid consumables, gold for the bank.</p>
  ${isOfficer ? `<details class="officer-box"${open.length ? '' : ' open'}><summary>Start a drive</summary>
    <form method="post" action="/drives" class="grid-form">${csrfField(csrf)}
      <label>Name<input name="title" required maxlength="80" placeholder="Durotar Supply crates"></label>
      <label>Collecting<input name="unit" required maxlength="40" placeholder="crates"></label>
      <label>Goal<input name="goal" type="number" min="1" required placeholder="200"></label>
      <label class="wide">Notes<input name="notes" maxlength="300" placeholder="Hand in at the Razor Hill camp, then log it here"></label>
      <button class="btn btn-primary">Start drive</button>
    </form></details>` : ''}
  <ul class="drives">${open.map(card).join('') || '<li class="empty">No drives running.</li>'}</ul>
  ${past.length ? `<h2>Finished</h2><ul class="drives">${past.map(card).join('')}</ul>` : ''}`;
}

module.exports = { bankPage, pricesPage, drivesPage };
