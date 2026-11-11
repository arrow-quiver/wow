// The overlay window (main/overlay.js, Ctrl+Shift+G) loads the whole app with ?overlay=1: the same pages, in the
// war-table layout (an icon rail, the overlay bar with quick actions, live alerts and spoken alerts).
export const OVERLAY = (() => {
  try { return new URLSearchParams(window.location.search).get('overlay') === '1'; } catch { return false; }
})();

// The war-table look covers the whole document (dialogs and toasts too): styles/app.css ":root.is-overlay".
if (OVERLAY) { try { document.documentElement.classList.add('is-overlay'); } catch { /* no document: tests */ } }

// Spoken alerts (this window's own choice, remembered in its browser storage).
const SPEAK_KEY = 'gc-overlay-speak';
export function speakOn() {
  try { return window.localStorage.getItem(SPEAK_KEY) === '1'; } catch { return false; }
}
export function setSpeak(on) {
  try { window.localStorage.setItem(SPEAK_KEY, on ? '1' : '0'); } catch { /* private mode: just this time */ }
}
export function speak(text) {
  try {
    if (!speakOn() || !window.speechSynthesis || !text) return false;
    const u = new window.SpeechSynthesisUtterance(String(text).replace(/[*_`]/g, ''));
    u.rate = 1.05; u.pitch = 0.85; u.volume = 0.9;
    window.speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}
