// "A change in your name arrived that this computer didn't make" (docs/SHARING.md §5): one notice per open author
// check from GET /api/share/status, with "It was me" (nothing changes) and "Undo it" (sends my previous version
// again, or removes the record). Nothing happens by itself, so a second PC of the same player is never fought.
// The core's other kinds (a group of changes of a kind this version doesn't know, whose second button only closes the
// check: "Close it"; my player id made on a character that isn't mine; characters an older version linked to me) get
// their own words (lib/status.js authorCheckView);
// a kind this version doesn't know reads like a plain change. Shown on Camp and on Addon & sync.
//
//   html`<${AuthorChecks} checks=${shareGroups(status).checks} onChanged=${reload} />`
import { html, useState } from '../lib/html.js';
import { api } from '../lib/api.js';
import { shareStatus, syncStatus, authorCheckView, savedLine, savedReply } from '../lib/status.js';
import { Notice } from './feedback.js';
import { Button } from './Button.js';
import { TimeAgo } from './wow.js';
import { toast } from './Toasts.js';

function AuthorCheck({ check, onChanged }) {
  const [busy, setBusy] = useState('');
  const view = authorCheckView(check);
  const run = async (action) => {
    setBusy(action);
    try {
      const r = await api.post(`/api/share/author-checks/${encodeURIComponent(check.id)}`, { action });
      // The core's saved line gets the restart wording while the game needs a restart to load the news folder.
      toast(savedReply(r && r.message, syncStatus.get()) || (action === 'undo' ? savedLine(syncStatus.get()) : 'Thanks. Nothing changes.'), 'ok');
      if (onChanged) onChanged(action);
    } catch (err) {
      toast((err && err.message) || 'That did not work. Please try again.', 'alarm');
    } finally {
      setBusy('');
      shareStatus.refresh();
    }
  };
  return html`<${Notice} kind="warn" icon="shield" class="share-check">
    <p class="share-check-text">${view.text}${check.at ? html` <span class="hint nowrap"><${TimeAgo} t=${check.at} /></span>` : null}</p>
    <div class="row share-check-actions">
      <${Button} size="sm" busy=${busy === 'mine'} disabled=${Boolean(busy)} onClick=${() => run('mine')}>${view.mine}<//>
      <${Button} size="sm" variant="primary" icon=${view.undoIcon || 'refresh'} busy=${busy === 'undo'} disabled=${Boolean(busy)} onClick=${() => run('undo')}>${view.undo}<//>
    </div>
  <//>`;
}

export function AuthorChecks({ checks, onChanged, class: cls }) {
  if (!Array.isArray(checks) || !checks.length) return null;
  return html`<div class=${`stack stack--tight share-checks ${cls || ''}`.trim()} aria-label="Changes in your name to check">
    ${checks.map((c) => html`<${AuthorCheck} key=${c.id} check=${c} onChanged=${onChanged} />`)}
  </div>`;
}

export default AuthorChecks;
