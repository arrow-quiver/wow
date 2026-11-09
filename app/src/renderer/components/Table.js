// Data table with an empty state and optional sorting.
//
//   html`<${Table}
//     columns=${[
//       { key: 'name', label: 'Character', render: (r) => html`<${ClassName} name=${r.name} cls=${r.class} />`, sortable: true },
//       { key: 'level', label: 'Level', num: true, sortable: true },
//       { key: 'last_seen', label: 'Last seen', render: (r) => html`<${TimeAgo} t=${r.last_seen} />`, sortable: true },
//     ]}
//     rows=${data.characters} sort=${{ key: 'level', dir: 'desc' }} empty="Nobody has synced yet." />`
//
// Column options: key, label, render(row, index), value(row) (sort value; defaults to row[key]), sortable,
// num (right aligned, numeric), align ('left'|'center'|'right'), width, class, title.
// Table options: rows, rowKey(row, i), empty (text or vnode), emptyTitle, sort ({ key, dir }), onRowClick(row),
// rowClass(row), caption, dense.
import { html, cx, useState, useMemo } from '../lib/html.js';
import { Icon } from './Icon.js';
import { Empty } from './feedback.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a, b) {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an || bn) return an && bn ? 0 : an ? 1 : -1; // empty values sort last
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? -1 : 1;
  return collator.compare(String(a), String(b));
}

export function sortRows(rows, columns, sort) {
  if (!sort || !sort.key) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return rows;
  const get = col.value || ((r) => r[col.key]);
  const dir = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const an = x.v === null || x.v === undefined || x.v === '';
      const bn = y.v === null || y.v === undefined || y.v === '';
      if (an !== bn) return an ? 1 : -1; // empties last in both directions
      return compare(x.v, y.v) * dir || x.i - y.i;
    })
    .map((x) => x.row);
}

export function Table({
  columns = [], rows, rowKey, empty = 'Nothing here yet.', emptyTitle, sort: initialSort, onRowClick, rowClass,
  caption, dense = false, class: cls,
}) {
  const [sort, setSort] = useState(initialSort || null);
  const list = rows || [];
  const sorted = useMemo(() => sortRows(list, columns, sort), [list, columns, sort]);

  if (!list.length) {
    return typeof empty === 'string' || empty === undefined
      ? html`<${Empty} compact title=${emptyTitle || empty} icon="info" />`
      : empty;
  }

  const toggle = (col) => {
    setSort((s) => {
      if (!s || s.key !== col.key) return { key: col.key, dir: col.num ? 'desc' : 'asc' };
      return { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
    });
  };
  const alignClass = (c) => (c.num || c.align === 'right' ? 'num' : c.align === 'center' ? 'center' : undefined);

  return html`<div class="table-wrap">
    <table class=${cx('table', dense && 'table--dense', cls)}>
      ${caption ? html`<caption>${caption}</caption>` : null}
      <thead><tr>
        ${columns.map((c) => {
          const active = sort && sort.key === c.key;
          const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined;
          return html`<th key=${c.key} scope="col" class=${cx(alignClass(c), c.class)} style=${c.width ? `width:${c.width}` : undefined} aria-sort=${ariaSort} title=${c.title}>
            ${c.sortable
              ? html`<button type="button" class="th-sort" onClick=${() => toggle(c)}>
                  ${c.label}<${Icon} name=${active ? (sort.dir === 'asc' ? 'sortAsc' : 'sortDesc') : 'sort'} />
                </button>`
              : c.label}
          </th>`;
        })}
      </tr></thead>
      <tbody>
        ${sorted.map((row, i) => {
          const key = rowKey ? rowKey(row, i) : row.id ?? row.key ?? row.name ?? i;
          const click = onRowClick ? () => onRowClick(row) : undefined;
          return html`<tr key=${key} class=${cx(onRowClick && 'is-clickable', rowClass && rowClass(row))}
              onClick=${click} tabIndex=${onRowClick ? 0 : undefined}
              onKeyDown=${onRowClick ? (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); click(); } } : undefined}>
            ${columns.map((c) => html`<td key=${c.key} class=${cx(alignClass(c), c.class)}>${c.render ? c.render(row, i) : row[c.key] ?? ''}</td>`)}
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}
