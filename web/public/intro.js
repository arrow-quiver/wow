// Loading screen: shown on the first page of each visit (once per browser tab session).
// Loaded in <head> without defer so the site stays hidden until the intro is on screen.
// Skip it with ?intro=0, show it again with ?intro=1.
(function () {
  var KEY = 'wowIntroSeen';
  var store = { get: function () { try { return sessionStorage.getItem(KEY); } catch (e) { return '1'; } },
    set: function () { try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ } } };
  var q = location.search;
  if (/[?&]intro=1\b/.test(q)) { try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  if (/[?&]intro=0\b/.test(q)) store.set();
  if (store.get() || navigator.webdriver && !/[?&]intro=1\b/.test(q)) return;
  store.set();
  var html = document.documentElement;
  html.classList.add('intro-on');
  // Give up after 15 seconds if something goes wrong, so the site is never stuck hidden.
  var safety = setTimeout(function () { html.classList.remove('intro-on'); }, 15000);

  var fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;700&family=Uncial+Antiqua&family=Montserrat:wght@400;500&display=swap';
  document.head.appendChild(fonts);

  var MARKUP = '' +
'<div class="scene">' +
' <div class="sky"></div><div class="clouds"></div><div class="aurora"></div><div class="moon"></div><div class="castle-glow"></div>' +
' <svg class="world" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
'  <defs>' +
'   <linearGradient id="intro-stone" x2="0" y2="1"><stop stop-color="#56515a"/><stop offset=".5" stop-color="#282b34"/><stop offset="1" stop-color="#101319"/></linearGradient>' +
'   <linearGradient id="intro-castle" x2="0" y2="1"><stop stop-color="#71616a"/><stop offset="1" stop-color="#292832"/></linearGradient>' +
'   <linearGradient id="intro-fire" x2="0" y2="1"><stop stop-color="#ffe6a2"/><stop offset="1" stop-color="#a13c25"/></linearGradient>' +
'   <filter id="intro-blur"><feGaussianBlur stdDeviation="14"/></filter>' +
'  </defs>' +
'  <g class="back">' +
'   <path d="M0 550 L140 360 250 430 420 210 560 420 710 170 850 400 1020 230 1150 400 1320 190 1470 400 1600 280 1600 900 0 900Z" fill="#252a37"/>' +
'   <path d="M0 530 L140 360 250 430 420 210 560 420 710 170 850 400 1020 230 1150 400 1320 190 1470 400 1600 280" fill="none" stroke="#777783" stroke-opacity=".18" stroke-width="4"/>' +
'   <path d="M0 610 L200 430 350 520 540 350 700 550 890 340 1080 530 1270 360 1440 520 1600 410 1600 900 0 900Z" fill="#171e2a"/>' +
'   <path d="M0 650 Q250 520 450 630 T850 590 T1250 600 T1600 550 L1600 900 0 900Z" fill="#111821"/>' +
'  </g>' +
'  <g transform="translate(750 270)">' +
'   <ellipse cx="250" cy="430" rx="330" ry="80" fill="#d47b4b" opacity=".12" filter="url(#intro-blur)"/>' +
'   <g fill="#34323b" stroke="#8d7a75" stroke-opacity=".5" stroke-width="3">' +
'    <path d="M80 380V105L135 35 190 105V380Z"/><path d="M340 380V55L405 -10 470 55V380Z"/><path d="M510 400V140L565 80 620 140V400Z"/><path d="M0 390V200L45 150 90 200V390Z"/>' +
'   </g>' +
'   <g fill="#14151c"><path d="M80 105L135 35 190 105Z"/><path d="M340 55L405 -10 470 55Z"/><path d="M510 140L565 80 620 140Z"/><path d="M0 200L45 150 90 200Z"/></g>' +
'   <path d="M40 400V220L150 170 260 220V400Z" fill="url(#intro-castle)" stroke="#9b8580" stroke-opacity=".5" stroke-width="3"/>' +
'   <path d="M150 400V80L250 15 350 80V400Z" fill="url(#intro-stone)" stroke="#a38d7d" stroke-opacity=".65" stroke-width="4"/>' +
'   <path d="M150 80L250 15 350 80Z" fill="#403640" stroke="#9b8174" stroke-width="3"/>' +
'   <path d="M180 400V160L250 112 320 160V400Z" fill="#171821"/>' +
'   <g fill="url(#intro-fire)" class="castle-light">' +
'    <path d="M215 190 Q250 155 285 190V250H215Z"/><path d="M95 260 Q115 235 135 260V300H95Z"/><path d="M365 180 Q405 150 445 180V235H365Z"/><path d="M530 245 Q565 210 600 245V285H530Z"/>' +
'   </g>' +
'   <path d="M207 400V310 Q250 235 293 310V400Z" fill="#080c12" stroke="#9a7555" stroke-width="4"/>' +
'   <path d="M222 400V315 Q250 270 278 315V400Z" fill="#8e392b" opacity=".55"/>' +
'   <g fill="#4b4144"><path d="M140 80V55H165V80H185V55H210V80H235V55H260V80H285V55H310V80H360V110H140Z"/><path d="M65 220V195H90V220H115V195H140V220H165V195H190V220Z"/></g>' +
'   <g stroke="#b68b53" stroke-width="2"><path d="M250 15V-80"/><path d="M250 -80L325 -65 250 -25Z" fill="#8e2528"/><path d="M405 -10V-100"/><path d="M405 -100L475 -85 405 -45Z" fill="#8e2528"/></g>' +
'   <path d="M245 -67L258 -56 245 -45 232 -56Z" fill="#e0bd7c"/>' +
'  </g>' +
'  <path d="M0 700 L130 620 270 670 410 620 570 680 700 650 850 720 1000 660 1160 700 1300 640 1450 690 1600 630 1600 900 0 900Z" fill="#101419"/>' +
'  <g fill="#080d12"><path d="M30 750l-50 -150h25l-15 -65h55l-15 65h25z"/><path d="M110 770l-50 -160h25l-15 -70h55l-15 70h25z"/><path d="M1420 770l-50 -160h25l-15 -70h55l-15 70h25z"/><path d="M1510 780l-50 -160h25l-15 -70h55l-15 70h25z"/></g>' +
'  <path d="M0 820 Q400 740 800 830 T1600 800V900H0Z" fill="#080b0e"/>' +
' </svg>' +
' <svg class="dragon" viewBox="0 0 700 320" aria-hidden="true">' +
'  <g fill="#111018" stroke="#75616a" stroke-opacity=".35" stroke-width="2">' +
'   <path class="wing" d="M330 155 Q200 80 80 20 Q125 120 190 170 Q120 150 35 140 Q120 245 285 215Z"/>' +
'   <path d="M390 145 Q510 25 640 10 Q595 110 520 170 Q610 145 685 130 Q620 235 430 215Z"/>' +
'   <path d="M300 180 Q340 145 390 165 L440 215 390 230 340 210Z"/><path d="M370 165 Q390 110 455 95 L505 110 470 135 420 145Z"/>' +
'   <path d="M440 110 L480 80 493 105 465 125Z"/><path d="M470 105L505 92 489 115Z"/><path d="M470 104L510 65 493 105Z"/>' +
'   <path d="M325 190L260 240 295 225 330 250 365 215Z"/><path d="M365 215L410 255 420 225Z"/><path d="M300 185L245 205 275 185Z"/>' +
'  </g>' +
'  <path d="M470 112L485 109" stroke="#e5a86b" stroke-width="4"/><path d="M478 107L486 108" stroke="#ffbd73" stroke-width="3"/>' +
' </svg>' +
' <div class="haze"></div>' +
// Adventuring party: a warrior, a mage and a ranger standing on the ridge.
' <svg class="hero-party" viewBox="0 0 520 300" aria-hidden="true">' +
'  <defs><radialGradient id="intro-orb"><stop stop-color="#e8f4ff"/><stop offset=".45" stop-color="#8fc3ff"/><stop offset="1" stop-color="#3a6fd0" stop-opacity="0"/></radialGradient></defs>' +
'  <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">' +
'   <path d="M88 150 Q68 220 76 288 L142 288 Q150 220 132 150Z" fill="#3a1416"/>' +
'   <path d="M86 290 L95 214 L110 214 L104 290Z"/><path d="M116 290 L118 214 L132 214 L139 290Z"/>' +
'   <path d="M88 222 L82 150 Q110 136 138 150 L132 222Z"/>' +
'   <ellipse cx="84" cy="153" rx="18" ry="11"/><ellipse cx="136" cy="153" rx="18" ry="11"/>' +
'   <path d="M98 142 Q96 112 110 107 Q124 112 122 142Z"/><path d="M99 121 L83 102 L101 113Z"/><path d="M121 121 L137 102 L119 113Z"/>' +
'   <path d="M136 156 L160 136 L166 143 L142 166Z"/><path d="M160 139 L205 58 L212 62 L168 143Z" fill="#2a2a33"/><path d="M152 130 L174 145" stroke="#b68b53" stroke-opacity="1" stroke-width="4"/>' +
'   <path d="M48 176 Q50 150 74 147 Q98 150 100 176 Q98 211 74 229 Q50 211 48 176Z" fill="#1b1a22"/>' +
'   <path d="M74 166 L82 180 L74 196 L66 180Z" fill="#b68b53" stroke="none"/>' +
'  </g>' +
'  <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">' +
'   <path d="M230 290 Q237 212 246 162 Q261 151 276 162 Q284 212 292 290Z" fill="#1c1830"/>' +
'   <path d="M244 205 L278 205 L279 212 L243 212Z" fill="#b68b53" stroke="none"/>' +
'   <path d="M243 164 Q248 122 263 82 Q270 122 280 164Z"/><ellipse cx="261" cy="162" rx="27" ry="6"/>' +
'   <path d="M273 182 L301 171 L303 179 L277 192Z"/>' +
'   <path d="M299 290 L303 290 L308 124 L304 124Z" fill="#2a2228"/>' +
'   <circle class="orb" cx="306" cy="112" r="20" fill="url(#intro-orb)" stroke="none"/><circle cx="306" cy="112" r="6" fill="#dff0ff" stroke="none"/>' +
'  </g>' +
'  <g class="hero" fill="#0d0e14" stroke="#7a6670" stroke-opacity=".45" stroke-width="2">' +
'   <path d="M384 158 Q366 230 375 284 L429 284 Q436 230 418 158Z" fill="#17241c"/>' +
'   <path d="M374 150 L387 145 L398 202 L386 206Z" fill="#2a2228"/><path d="M376 150 L370 136 M381 148 L377 133 M386 147 L385 132" stroke="#b68b53" stroke-opacity=".9"/>' +
'   <path d="M381 290 L389 214 L401 214 L395 290Z"/><path d="M405 290 L406 214 L419 214 L425 290Z"/>' +
'   <path d="M383 222 L387 160 Q402 150 417 160 L421 222Z"/>' +
'   <path d="M386 166 Q388 129 402 122 Q418 129 417 166 Q402 156 386 166Z"/>' +
'   <path d="M414 176 L443 188 L441 196 L412 186Z"/>' +
'   <path d="M440 118 Q478 190 440 262" fill="none" stroke="#6f5a4a" stroke-opacity="1" stroke-width="4"/>' +
'   <path d="M440 118 L440 262" stroke="#c9b48f" stroke-opacity=".7" stroke-width="1"/>' +
'  </g>' +
' </svg>' +
' <canvas id="intro-particles"></canvas>' +
' <div class="light-beam"></div><div class="vignette"></div><div class="grain"></div>' +
'</div>' +
'<div class="frame"></div><div class="corner c1"></div><div class="corner c2"></div>' +
'<button class="skip" type="button" id="intro-skip">SKIP ✕</button>' +
'<header class="top">' +
' <div class="crest"><div class="crest-inner"><span>J</span></div></div>' +
' <div class="guild-name">JUST NOW WOW</div>' +
' <div class="divider">✦</div>' +
' <div class="subtitle">A Brotherhood Beyond the Realm</div>' +
'</header>' +
'<div class="story">' +
' <div class="kicker">✦ &nbsp; THE WORLD OF AZEROTH &nbsp; ✦</div>' +
' <h1>Some worlds<br>are worth fighting for.</h1>' +
' <div class="ornament"></div>' +
' <p>Ancient powers awaken. Kingdoms rise and fall. Heroes answer the call. Your story is waiting to be written.</p>' +
' <div class="quote">FOR THE HORDE. FOR THE ADVENTURE.</div>' +
'</div>' +
'<div class="right-mark">Azeroth &nbsp; · &nbsp; Beyond the Horizon &nbsp; · &nbsp; Forever</div>' +
'<section class="bottom">' +
' <div class="load-row"><span id="intro-status">SUMMONING THE REALM</span><span id="intro-percent">00%</span></div>' +
' <div class="track"><div class="loadbar" id="intro-bar"></div></div>' +
' <div class="load-meta"><span id="intro-hint">PREPARING YOUR ADVENTURE</span><span>JUST NOW WOW</span></div>' +
' <button class="enter" type="button" id="intro-enter">ENTER AZEROTH &nbsp; ✦</button>' +
'</section>' +
'<div class="version">THE ADVENTURE NEVER ENDS &nbsp; · &nbsp; V. 01</div>';

  function start() {
    var root = document.createElement('div');
    root.id = 'intro';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Loading the guild site');
    root.innerHTML = MARKUP;
    document.body.appendChild(root);
    clearTimeout(safety);

    var $ = function (id) { return document.getElementById(id); };
    var bar = $('intro-bar'), percent = $('intro-percent'), status = $('intro-status'), hint = $('intro-hint'), enter = $('intro-enter');
    var stages = [
      [12, 'AWAKENING ANCIENT POWERS', 'THE OLD WORLD STIRS'],
      [28, 'SUMMONING THE HEROES', 'GATHERING THE BRAVE'],
      [46, 'CALLING THE DRAGONS', 'WINGS OVER AZEROTH'],
      [65, 'PREPARING THE BATTLEFIELDS', 'THE KINGDOMS AWAIT'],
      [82, 'OPENING THE GATES', 'YOUR DESTINY APPROACHES'],
      [95, 'THE REALM IS READY', 'THE ADVENTURE BEGINS'],
    ];
    var value = 0, ready = document.readyState === 'complete', complete = false, started = Date.now(), gone = false;

    function draw() {
      if (complete || gone) return;
      if (value < 94) value += Math.max(0.08, (94 - value) * 0.014);
      var n = Math.floor(value);
      bar.style.width = n + '%';
      percent.textContent = (n < 10 ? '0' : '') + n + '%';
      for (var i = stages.length - 1; i >= 0; i--) if (n >= stages[i][0]) { status.textContent = stages[i][1]; hint.textContent = stages[i][2]; break; }
      if (ready && Date.now() - started > 3500) {
        complete = true;
        bar.style.width = '100%'; percent.textContent = '100%';
        status.textContent = 'THE REALM IS READY'; hint.textContent = 'YOUR LEGEND STARTS HERE';
        enter.classList.add('show');
        enter.focus({ preventScroll: true });
        return;
      }
      requestAnimationFrame(draw);
    }
    function hide() {
      if (gone) return; gone = true;
      root.classList.add('exit');
      html.classList.remove('intro-on');
      document.removeEventListener('keydown', onKey);
      setTimeout(function () { root.remove(); }, 1700);
    }
    function onKey(e) { if (e.key === 'Escape' || (complete && e.key === 'Enter')) { e.preventDefault(); hide(); } }
    enter.addEventListener('click', hide);
    $('intro-skip').addEventListener('click', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('load', function () { ready = true; });
    setTimeout(function () { ready = true; }, 10000);
    window.WOW_LOADER = { finish: function () { ready = true; }, hide: hide };
    requestAnimationFrame(draw);

    // Embers, sparks and magical dust
    var canvas = $('intro-particles');
    var ctx = canvas.getContext('2d');
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var particles = [];
    function resize() {
      var d = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = innerWidth * d; canvas.height = innerHeight * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    resize();
    addEventListener('resize', resize);
    function particle(initial) {
      return { x: Math.random() * innerWidth, y: initial ? Math.random() * innerHeight : innerHeight + 20, r: Math.random() * 1.7 + 0.35,
        vy: Math.random() * 0.7 + 0.2, vx: (Math.random() - 0.5) * 0.45, alpha: Math.random() * 0.6 + 0.12, phase: Math.random() * 6.28, warm: Math.random() };
    }
    for (var i = 0; i < (innerWidth < 700 ? 70 : 140); i++) particles.push(particle(true));
    function animate() {
      if (gone) return;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        if (!reduce) { p.y -= p.vy; p.x += p.vx + Math.sin(p.phase += 0.012) * 0.12; }
        if (p.y < -20) particles[j] = p = particle(false);
        var warm = p.warm > 0.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + (warm ? '222,153,91' : '174,189,206') + ',' + p.alpha + ')';
        ctx.shadowBlur = 10;
        ctx.shadowColor = warm ? '#db9456' : '#9db9d5';
        ctx.fill();
      }
      if (!reduce) requestAnimationFrame(animate);
    }
    animate();
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
