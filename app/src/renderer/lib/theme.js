// settings.theme: 'system' (follow Windows), 'light' or 'dark'. Applied as <html data-theme>.
export const THEMES = [
  { value: 'system', label: 'Match Windows' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function applyTheme(theme) {
  const el = document.documentElement;
  if (theme === 'light' || theme === 'dark') el.dataset.theme = theme;
  else delete el.dataset.theme;
}

// The theme actually on screen right now.
export function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
