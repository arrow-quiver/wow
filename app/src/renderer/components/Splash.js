// Startup splash: the old site's "Just Now WoW" loading screen (public/intro.js + intro.css), shortened for the app.
// Shown at most once a day, skipped with a click, Escape or Enter, and never shown with reduced motion.
// Preview overrides: ?splash=1 forces it, ?splash=hold forces it and keeps it up until clicked, ?splash=0 hides it.
import { html, useEffect, useRef, useState } from '../lib/html.js';

const KEY = 'gc.splashDay';
const RUN_MS = 2600;   // the bar fills in this time
const HOLD_MS = 450;   // then it waits a moment on "ready"
const FADE_MS = 900;   // and fades out

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function shouldShowSplash() {
  try {
    const q = new URLSearchParams(window.location.search).get('splash');
    if (q === '0') return false;
    if (q === '1') return true;
    if (q === 'hold') return 'hold';
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (navigator.webdriver) return false;
    if (document.hidden) return false; // started hidden in the tray: nobody would see it
    const today = localDay();
    if (window.localStorage.getItem(KEY) === today) return false;
    window.localStorage.setItem(KEY, today);
    return true;
  } catch {
    return false; // storage blocked: better to skip than to show it every time
  }
}

// Runs cb once the window becomes visible (the main process may show the window a moment after the page
// starts, or keep it in the tray with --hidden). Gives up after timeoutMs. Returns a cancel function.
export function whenVisible(cb, timeoutMs = 3000) {
  if (!document.hidden) { cb(); return () => {}; }
  let done = false;
  const finish = (run) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onChange);
    if (run) cb();
  };
  const onChange = () => { if (!document.hidden) finish(true); };
  const timer = setTimeout(() => finish(false), timeoutMs);
  document.addEventListener('visibilitychange', onChange);
  return () => finish(false);
}

const STAGES = [
  [0, 'SUMMONING THE REALM', 'PREPARING YOUR ADVENTURE'],
  [12, 'AWAKENING ANCIENT POWERS', 'THE OLD WORLD STIRS'],
  [28, 'SUMMONING THE HEROES', 'GATHERING THE BRAVE'],
  [46, 'CALLING THE DRAGONS', 'WINGS OVER AZEROTH'],
  [65, 'PREPARING THE BATTLEFIELDS', 'THE KINGDOMS AWAIT'],
  [82, 'OPENING THE GATES', 'YOUR DESTINY APPROACHES'],
  [100, 'THE REALM IS READY', 'YOUR LEGEND STARTS HERE'],
];

// Static scenery from the old intro (sky, castle, dragon, the adventuring party). No user data in here.
const SCENE = `
<div class="sky"></div><div class="clouds"></div><div class="aurora"></div><div class="moon"></div><div class="castle-glow"></div>
<svg class="world" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
 <defs>
  <linearGradient id="splash-stone" x2="0" y2="1"><stop stop-color="#56515a"/><stop offset=".5" stop-color="#282b34"/><stop offset="1" stop-color="#101319"/></linearGradient>
  <linearGradient id="splash-castle" x2="0" y2="1"><stop stop-color="#71616a"/><stop offset="1" stop-color="#292832"/></linearGradient>
  <linearGradient id="splash-fire" x2="0" y2="1"><stop stop-color="#ffe6a2"/><stop offset="1" stop-color="#a13c25"/></linearGradient>
  <filter id="splash-blur"><feGaussianBlur stdDeviation="14"/></filter>
 </defs>
 <g class="back">
  <path d="M0 550 L140 360 250 430 420 210 560 420 710 170 850 400 1020 230 1150 400 1320 190 1470 400 1600 280 1600 900 0 900Z" fill="#252a37"/>
  <path d="M0 530 L140 360 250 430 420 210 560 420 710 170 850 400 1020 230 1150 400 1320 190 1470 400 1600 280" fill="none" stroke="#777783" stroke-opacity=".18" stroke-width="4"/>
  <path d="M0 610 L200 430 350 520 540 350 700 550 890 340 1080 530 1270 360 1440 520 1600 410 1600 900 0 900Z" fill="#171e2a"/>
  <path d="M0 650 Q250 520 450 630 T850 590 T1250 600 T1600 550 L1600 900 0 900Z" fill="#111821"/>
 </g>
 <g transform="translate(750 270)">
  <ellipse cx="250" cy="430" rx="330" ry="80" fill="#d47b4b" opacity=".12" filter="url(#splash-blur)"/>
  <g fill="#34323b" stroke="#8d7a75" stroke-opacity=".5" stroke-width="3">
   <path d="M80 380V105L135 35 190 105V380Z"/><path d="M340 380V55L405 -10 470 55V380Z"/><path d="M510 400V140L565 80 620 140V400Z"/><path d="M0 390V200L45 150 90 200V390Z"/>
  </g>
  <g fill="#14151c"><path d="M80 105L135 35 190 105Z"/><path d="M340 55L405 -10 470 55Z"/><path d="M510 140L565 80 620 140Z"/><path d="M0 200L45 150 90 200Z"/></g>
  <path d="M40 400V220L150 170 260 220V400Z" fill="url(#splash-castle)" stroke="#9b8580" stroke-opacity=".5" stroke-width="3"/>
  <path d="M150 400V80L250 15 350 80V400Z" fill="url(#splash-stone)" stroke="#a38d7d" stroke-opacity=".65" stroke-width="4"/>
  <path d="M150 80L250 15 350 80Z" fill="#403640" stroke="#9b8174" stroke-width="3"/>
  <path d="M180 400V160L250 112 320 160V400Z" fill="#171821"/>
  <g fill="url(#splash-fire)" class="castle-light">
   <path d="M215 190 Q250 155 285 190V250H215Z"/><path d="M95 260 Q115 235 135 260V300H95Z"/><path d="M365 180 Q405 150 445 180V235H365Z"/><path d="M530 245 Q565 210 600 245V285H530Z"/>
  </g>
  <path d="M207 400V310 Q250 235 293 310V400Z" fill="#080c12" stroke="#9a7555" stroke-width="4"/>
  <path d="M222 400V315 Q250 270 278 315V400Z" fill="#8e392b" opacity=".55"/>
  <g fill="#4b4144"><path d="M140 80V55H165V80H185V55H210V80H235V55H260V80H285V55H310V80H360V110H140Z"/><path d="M65 220V195H90V220H115V195H140V220H165V195H190V220Z"/></g>
  <g stroke="#b68b53" stroke-width="2"><path d="M250 15V-80"/><path d="M250 -80L325 -65 250 -25Z" fill="#8e2528"/><path d="M405 -10V-100"/><path d="M405 -100L475 -85 405 -45Z" fill="#8e2528"/></g>
  <path d="M245 -67L258 -56 245 -45 232 -56Z" fill="#e0bd7c"/>
 </g>
 <path d="M0 700 L130 620 270 670 410 620 570 680 700 650 850 720 1000 660 1160 700 1300 640 1450 690 1600 630 1600 900 0 900Z" fill="#101419"/>
 <g fill="#080d12"><path d="M30 750l-50 -150h25l-15 -65h55l-15 65h25z"/><path d="M110 770l-50 -160h25l-15 -70h55l-15 70h25z"/><path d="M1420 770l-50 -160h25l-15 -70h55l-15 70h25z"/><path d="M1510 780l-50 -160h25l-15 -70h55l-15 70h25z"/></g>
 <path d="M0 820 Q400 740 800 830 T1600 800V900H0Z" fill="#080b0e"/>
</svg>
<svg class="dragon" viewBox="0 0 700 320" aria-hidden="true">
 <g fill="#111018" stroke="#75616a" stroke-opacity=".35" stroke-width="2">
  <path class="wing" d="M330 155 Q200 80 80 20 Q125 120 190 170 Q120 150 35 140 Q120 245 285 215Z"/>
  <path d="M390 145 Q510 25 640 10 Q595 110 520 170 Q610 145 685 130 Q620 235 430 215Z"/>
  <path d="M300 180 Q340 145 390 165 L440 215 390 230 340 210Z"/><path d="M370 165 Q390 110 455 95 L505 110 470 135 420 145Z"/>
  <path d="M440 110 L480 80 493 105 465 125Z"/><path d="M470 105L505 92 489 115Z"/><path d="M470 104L510 65 493 105Z"/>
  <path d="M325 190L260 240 295 225 330 250 365 215Z"/><path d="M365 215L410 255 420 225Z"/><path d="M300 185L245 205 275 185Z"/>
 </g>
 <path d="M470 112L485 109" stroke="#e5a86b" stroke-width="4"/><path d="M478 107L486 108" stroke="#ffbd73" stroke-width="3"/>
</svg>
<div class="haze"></div>
<svg class="hero-party" viewBox="0 0 520 300" aria-hidden="true">
 <defs><radialGradient id="splash-orb"><stop stop-color="#e8f4ff"/><stop offset=".45" stop-color="#8fc3ff"/><stop offset="1" stop-color="#3a6fd0" stop-opacity="0"/></radialGradient></defs>
 <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">
  <path d="M88 150 Q68 220 76 288 L142 288 Q150 220 132 150Z" fill="#3a1416"/>
  <path d="M86 290 L95 214 L110 214 L104 290Z"/><path d="M116 290 L118 214 L132 214 L139 290Z"/>
  <path d="M88 222 L82 150 Q110 136 138 150 L132 222Z"/>
  <ellipse cx="84" cy="153" rx="18" ry="11"/><ellipse cx="136" cy="153" rx="18" ry="11"/>
  <path d="M98 142 Q96 112 110 107 Q124 112 122 142Z"/><path d="M99 121 L83 102 L101 113Z"/><path d="M121 121 L137 102 L119 113Z"/>
  <path d="M136 156 L160 136 L166 143 L142 166Z"/><path d="M160 139 L205 58 L212 62 L168 143Z" fill="#2a2a33"/><path d="M152 130 L174 145" stroke="#b68b53" stroke-opacity="1" stroke-width="4"/>
  <path d="M48 176 Q50 150 74 147 Q98 150 100 176 Q98 211 74 229 Q50 211 48 176Z" fill="#1b1a22"/>
  <path d="M74 166 L82 180 L74 196 L66 180Z" fill="#b68b53" stroke="none"/>
 </g>
 <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">
  <path d="M230 290 Q237 212 246 162 Q261 151 276 162 Q284 212 292 290Z" fill="#1c1830"/>
  <path d="M244 205 L278 205 L279 212 L243 212Z" fill="#b68b53" stroke="none"/>
  <path d="M243 164 Q248 122 263 82 Q270 122 280 164Z"/><ellipse cx="261" cy="162" rx="27" ry="6"/>
  <path d="M273 182 L301 171 L303 179 L277 192Z"/>
  <path d="M299 290 L303 290 L308 124 L304 124Z" fill="#2a2228"/>
  <circle class="orb" cx="306" cy="112" r="20" fill="url(#splash-orb)" stroke="none"/><circle cx="306" cy="112" r="6" fill="#dff0ff" stroke="none"/>
 </g>
 <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">
  <path d="M384 158 Q366 230 375 284 L429 284 Q436 230 418 158Z" fill="#17241c"/>
  <path d="M374 150 L387 145 L398 202 L386 206Z" fill="#2a2228"/><path d="M376 150 L370 136 M381 148 L377 133 M386 147 L385 132" stroke="#b68b53" stroke-opacity=".9"/>
  <path d="M381 290 L389 214 L401 214 L395 290Z"/><path d="M405 290 L406 214 L419 214 L425 290Z"/>
  <path d="M383 222 L387 160 Q402 150 417 160 L421 222Z"/>
  <path d="M386 166 Q388 129 402 122 Q418 129 417 166 Q402 156 386 166Z"/>
  <path d="M414 176 L443 188 L441 196 L412 186Z"/>
  <path d="M440 118 Q478 190 440 262" fill="none" stroke="#6f5a4a" stroke-opacity="1" stroke-width="4"/>
  <path d="M440 118 L440 262" stroke="#c9b48f" stroke-opacity=".7" stroke-width="1"/>
 </g>
</svg>`;

const OVERLAY = '<div class="light-beam"></div><div class="vignette"></div><div class="grain"></div>';

// Embers, sparks and magical dust drifting up (port of the old canvas loop). Returns a stop function.
function startParticles(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  let w = 0;
  let h = 0;
  let stopped = false;
  const resize = () => {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * d;
    canvas.height = h * d;
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
  const make = (initial) => ({
    x: Math.random() * w, y: initial ? Math.random() * h : h + 20, r: Math.random() * 1.7 + 0.35,
    vy: Math.random() * 0.7 + 0.2, vx: (Math.random() - 0.5) * 0.45, alpha: Math.random() * 0.6 + 0.12,
    phase: Math.random() * 6.28, warm: Math.random() > 0.3,
  });
  const parts = Array.from({ length: w < 700 ? 70 : 140 }, () => make(true));
  const frame = () => {
    if (stopped) return;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      p.y -= p.vy;
      p.x += p.vx + Math.sin((p.phase += 0.012)) * 0.12;
      if (p.y < -20) { p = make(false); parts[i] = p; }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.warm ? '222,153,91' : '174,189,206'},${p.alpha})`;
      ctx.shadowBlur = 10;
      ctx.shadowColor = p.warm ? '#db9456' : '#9db9d5';
      ctx.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => { stopped = true; window.removeEventListener('resize', resize); };
}

/**
 * <Splash guildName="Just Now WoW" faction="Horde" onDone=${() => setSplash(false)} />
 * `hold` keeps it on screen until it is clicked (for previews).
 */
export function Splash({ guildName, faction, hold = false, onDone }) {
  const [pct, setPct] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const canvasRef = useRef(null);
  const skipRef = useRef(null);
  const leavingRef = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const name = String(guildName || 'Guild Camp').toUpperCase();
  const crest = name.replace(/[^A-Z0-9]/g, '').charAt(0) || 'G';
  const side = faction === 'Alliance' ? 'ALLIANCE' : faction === 'Horde' ? 'HORDE' : null;

  const leave = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    setTimeout(() => doneRef.current?.(), FADE_MS);
  };

  useEffect(() => {
    const stop = canvasRef.current ? startParticles(canvasRef.current) : () => {};
    const started = performance.now();
    let raf = 0;
    const tick = (t) => {
      // Ease out towards 100 so it slows down near the end, like the old loader.
      const x = Math.min(1, (t - started) / RUN_MS);
      setPct(Math.round((1 - (1 - x) ** 2.2) * 100));
      if (x < 1) raf = requestAnimationFrame(tick);
      else if (!hold) setTimeout(leave, HOLD_MS);
    };
    raf = requestAnimationFrame(tick);
    // Never leave it stuck on screen (animation frames pause while the window is hidden).
    const safety = hold ? 0 : setTimeout(leave, 12000);
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); leave(); } };
    document.addEventListener('keydown', onKey);
    skipRef.current?.focus({ preventScroll: true });
    return () => { stop(); cancelAnimationFrame(raf); clearTimeout(safety); document.removeEventListener('keydown', onKey); };
  }, []);

  const stage = [...STAGES].reverse().find((s) => pct >= s[0]) || STAGES[0];

  return html`<div id="splash" class=${leaving ? 'exit' : ''} role="dialog" aria-label="Starting Guild Camp" onClick=${leave}>
    <div class="scene" dangerouslySetInnerHTML=${{ __html: SCENE }}></div>
    <canvas class="particles" ref=${canvasRef} aria-hidden="true"></canvas>
    <div class="overlays" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: OVERLAY }}></div>
    <div class="frame" aria-hidden="true"></div><div class="corner c1" aria-hidden="true"></div><div class="corner c2" aria-hidden="true"></div>
    <button class="skip" type="button" ref=${skipRef} onClick=${(e) => { e.stopPropagation(); leave(); }}>SKIP ✕</button>
    <header class="top">
      <div class="crest"><div class="crest-inner"><span>${crest}</span></div></div>
      <div class="guild-name">${name}</div>
      <div class="divider" aria-hidden="true">✦</div>
      <div class="subtitle">A Brotherhood Beyond the Realm</div>
    </header>
    <div class="story">
      <div class="kicker">✦ THE WORLD OF AZEROTH ✦</div>
      <h1>Some worlds<br />are worth fighting for.</h1>
      <div class="ornament"></div>
      <p>Ancient powers awaken. Kingdoms rise and fall. Heroes answer the call. Your story is waiting to be written.</p>
      <div class="quote">${side ? `FOR THE ${side}. FOR THE ADVENTURE.` : 'FOR THE GUILD. FOR THE ADVENTURE.'}</div>
    </div>
    <div class="right-mark" aria-hidden="true">Azeroth · Beyond the Horizon · Forever</div>
    <section class="bottom">
      <div class="load-row"><span>${stage[1]}</span><span>${String(pct).padStart(2, '0')}%</span></div>
      <div class="track"><div class="loadbar" style=${`width:${pct}%`}></div></div>
      <div class="load-meta"><span>${stage[2]}</span><span>${name}</span></div>
    </section>
    <div class="version">THE ADVENTURE NEVER ENDS · GUILD CAMP</div>
  </div>`;
}
