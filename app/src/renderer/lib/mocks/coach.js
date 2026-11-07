// Preview sample data for the coach pages (used only when the renderer runs in a plain browser without window.gc).
// The engineer who owns the coach pages keeps these shapes identical to docs/api/coach.md.
import { addMockRoutes, SCENARIO } from '../mock.js';

// Extra preview states with &coach=<mode> in the page URL: nokey | off | budget | empty | busy.
const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('coach') : null;
const AI = {
  nokey: { available: false, hasKey: false, enabled: true, budgetLeft: true, reason: "The AI part of the Coach isn't set up yet (the server has no Claude API key)." },
  off: { available: false, hasKey: true, enabled: false, budgetLeft: true, reason: "An officer has switched the Coach's AI off." },
  budget: { available: false, hasKey: true, enabled: true, budgetLeft: false, reason: "The guild's Coach budget for this month is used up. An officer can raise it in Guild settings." },
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const sqlTime = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const iso = (msAhead = 0) => new Date(Date.now() + msAhead).toISOString();
const unix = (msAgo = 0) => Math.floor((Date.now() - msAgo) / 1000);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SRC = [
  { url: 'https://www.wowhead.com/classic/guide/classes/warrior/arms-pvp', title: 'Arms Warrior PvP guide' },
  { url: 'https://warcraft.wiki.gg/wiki/Mortal_Strike', title: 'Mortal Strike - Warcraft Wiki' },
];

// My coach characters (the owner's characters in the base mock: Grimtusk and Shadowfen).
const CHARS = {
  Grimtusk: {
    name: 'Grimtusk', class: 'WARRIOR', level: 60, realm: 'Forever', updated_at: sqlTime(4 * MIN),
    profile: { scores: { aggression: 82, risk: 44, social: 38, pvp: 76, pace: 61 }, archetype: 'Warmonger',
      blurb: 'You go looking for fights and enjoy taking other players down.', minutes: 1840, quiz: true },
    stats: { minutes: 1840, pullsPerHour: 38.4, deathsPerHour: 0.7, pvpDeaths: 21, honorKills: 312, duelsWon: 14, duelsLost: 6,
      questsPerHour: 2.1, groupedShare: 0.38, flaggedShare: 0.81, battlegroundMinutes: 220, dungeonMinutes: 310 },
    quiz: { aggression: 5, risk: 3, social: 2, pvp: 5, pace: 3, role: 'Damage', goal: 'World PvP' },
    talents: { trees: [{ name: 'Arms', points: 29 }, { name: 'Fury', points: 20 }, { name: 'Protection', points: 0 }], unspent: 2,
      picked: [{ name: 'Improved Rend', rank: 3, max: 3, tree: 'Arms' }, { name: 'Tactical Mastery', rank: 5, max: 5, tree: 'Arms' },
        { name: 'Deep Wounds', rank: 3, max: 3, tree: 'Arms' }, { name: 'Two-Handed Weapon Specialization', rank: 5, max: 5, tree: 'Arms' }] },
    gear: { items: [{ slot: 'Main hand', id: 12784, name: 'Arcanite Reaper', ilvl: 63, quality: 4 }], lowestDurability: 18, freeSlots: 9 },
    plan_at: sqlTime(26 * HOUR), plan_level: 60, plan_requested_at: null,
    plan: {
      headline: 'Arms for world PvP: hit hard, stay mobile',
      summary: 'You start fights and chase kills, so go deep Arms for Mortal Strike and take Fury only for the crit. Pick fights near your friends and keep your Hamstring up.',
      spec: 'Arms', split: '31/20/0 at 60',
      talents: [
        { name: 'Improved Rend', tree: 'Arms', points: 3, why: 'Cheap early damage while levelling and a bleed in duels' },
        { name: 'Tactical Mastery', tree: 'Arms', points: 5, why: 'Keep your rage when you swap stances mid-fight' },
        { name: 'Deep Wounds', tree: 'Arms', points: 3, why: 'Your crits keep bleeding after the hit' },
        { name: 'Two-Handed Weapon Specialization', tree: 'Arms', points: 5, why: 'More damage with the big two-hander you carry' },
        { name: 'Mortal Strike', tree: 'Arms', points: 1, why: 'Your big hit, and it cuts healing on the target' },
        { name: 'Cruelty', tree: 'Fury', points: 5, why: 'More crits feed Deep Wounds and rage' },
        { name: 'Improved Battle Shout', tree: 'Fury', points: 5, why: 'More attack power for you and your group' },
      ],
      stats: ['Strength', 'Hit (up to 6%)', 'Critical strike', 'Stamina'],
      gear: [
        { slot: 'Weapon', advice: 'A slow two-hander (3.5+ speed) makes Mortal Strike and Overpower hit hardest.' },
        { slot: 'Trinkets', advice: 'Keep an Insignia of the Horde for stuns and fears in world PvP.' },
      ],
      next_steps: [
        { title: 'Spend your talent points', detail: 'Put them in Mortal Strike, then Cruelty.' },
        { title: 'Farm Thorium in Winterspring', detail: 'Pays for repairs and a better trinket; flagged players there give you fights too.' },
      ],
      tips: ['Open with Charge from max range, then Hamstring before anything else.', 'Save Intimidating Shout for when a healer shows up.', 'Swap to Defensive Stance and a shield when a rogue opens on you.'],
      confidence: 'classic', level: 60, model: 'claude-sonnet-5-5', at: unix(26 * HOUR), sources: SRC.slice(0, 1),
    },
  },
  Shadowfen: {
    name: 'Shadowfen', class: 'WARLOCK', level: 42, realm: 'Forever', updated_at: sqlTime(3 * 24 * HOUR),
    profile: { scores: { aggression: 34, risk: 22, social: 18, pvp: 20, pace: 48 }, archetype: 'Lone Wanderer',
      blurb: 'Calm, independent and thorough. You play at your own pace.', minutes: 95, quiz: false },
    stats: { minutes: 95, pullsPerHour: 21.5, deathsPerHour: 0.3, honorKills: 0, duelsWon: 0, duelsLost: 0, questsPerHour: 6.2, groupedShare: 0.12, flaggedShare: 0.05 },
    quiz: null,
    talents: { trees: [{ name: 'Affliction', points: 21 }, { name: 'Demonology', points: 12 }, { name: 'Destruction', points: 0 }], unspent: 0, picked: [] },
    gear: { items: [], lowestDurability: 64, freeSlots: 2 },
    plan_at: null, plan_level: null, plan_requested_at: null,
    plan: null,
  },
};

const QUESTIONS = [
  { id: 41, char_name: 'Grimtusk', source: 'app', question: 'Should I take Improved Charge or Deflection for world PvP?',
    answer: 'Take Deflection for now. Parrying more wins duels against rogues and other warriors.\nPick up Improved Charge once you have Mortal Strike: the extra rage lets you open with it straight away.',
    sources: SRC, status: 'answered', error: null, created_at: sqlTime(50 * MIN), answered_at: sqlTime(49 * MIN) },
  { id: 40, char_name: 'Grimtusk', source: 'game', question: 'Best place to farm Thorium as a warrior?',
    answer: 'Winterspring and Un\'Goro Crater. Winterspring has more nodes along the hot springs, and Un\'Goro has Rich Thorium at the walls.',
    sources: [], status: 'answered', error: null, created_at: sqlTime(20 * HOUR), answered_at: sqlTime(20 * HOUR - MIN) },
];

let nextId = 42;
let planBusyUntil = 0;

function charsList() {
  return Object.values(CHARS)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .map((c) => ({ name: c.name, class: c.class, level: c.level, realm: c.realm, updated_at: c.updated_at, archetype: c.profile?.archetype || null, hasPlan: !!c.plan }));
}

function planJson(c) {
  if (!c.plan) return null;
  const picked = new Map((c.talents?.picked || []).map((t) => [t.name.toLowerCase(), t.rank]));
  return { ...c.plan, talents: c.plan.talents.map((t) => ({ ...t, taken: picked.has(t.name.toLowerCase()), rank: picked.get(t.name.toLowerCase()) || null })) };
}

function nextSteps(c, plan) {
  const steps = [];
  const unspent = c.talents?.unspent || 0;
  if (unspent) {
    const next = plan && (plan.talents.find((t) => !t.taken) || plan.talents[0]);
    steps.push({ kind: 'talent', title: `Spend ${unspent} talent point${unspent === 1 ? '' : 's'}`, detail: next ? `Your plan says: ${next.name} (${next.tree}).` : 'Open your talents in game (N).' });
  }
  if (c.gear?.lowestDurability < 25) steps.push({ kind: 'repair', title: 'Repair your gear', detail: `Something is down to ${c.gear.lowestDurability}% durability.` });
  if (c.gear?.freeSlots < 4) steps.push({ kind: 'bags', title: 'Make bag space', detail: `Only ${c.gear.freeSlots} free bag slots. Vendor grey items or bank what you don't need.` });
  if (!c.quiz) steps.push({ kind: 'quiz', title: 'Tell the Coach how you play', detail: "Five quick questions. In game, type /wow coach and press 'Tune my style'." });
  steps.push({ kind: 'raid', title: 'Sign up: Molten Core', detail: 'Pick a character and role in Guild Camp.', route: '/raids/12', at: iso(2 * 24 * HOUR + 3 * HOUR) });
  for (const s of plan?.next_steps || []) steps.push({ kind: 'plan', title: s.title, detail: s.detail });
  return steps;
}

function myRole(state) {
  return (state.members || []).find((m) => m.id === state.userId)?.role || 'member';
}

function view({ query, state }) {
  if (!state.signedIn) throw httpError(401, 'Sign in first.');
  if (!state.inGuild) throw httpError(403, 'Join a guild first.');
  // Preview: answers that were "thinking" arrive after a few seconds.
  for (const q of QUESTIONS) {
    if (q.status === 'pending' && Date.now() - q._t > 4000) {
      Object.assign(q, { status: 'answered', answered_at: sqlTime(), sources: SRC.slice(1),
        answer: 'Mortal Strike first, every time it is ready. Use Overpower when the target dodges, and Whirlwind only when two enemies are close.' });
    }
  }
  if (planBusyUntil && Date.now() > planBusyUntil) {
    planBusyUntil = 0;
    CHARS.Shadowfen.plan = { ...CHARS.Grimtusk.plan, headline: 'Affliction for safe solo levelling', spec: 'Affliction', split: '31/20/0 at 60',
      summary: 'You play carefully on your own, so lean on damage over time and your Voidwalker.', level: 42, at: unix(),
      talents: [{ name: 'Improved Corruption', tree: 'Affliction', points: 5, why: 'Instant Corruption to cast while moving' }, { name: 'Fel Concentration', tree: 'Affliction', points: 5, why: 'Drain Life without being knocked back' }],
      stats: ['Stamina', 'Intellect', 'Spell damage'], next_steps: [{ title: 'Train your Voidwalker', detail: 'Sacrifice saves you when a pull goes wrong.' }] };
    CHARS.Shadowfen.plan_at = sqlTime();
  }
  // The member scenario shows the getting-started screen.
  const chars = SCENARIO === 'member' || MODE === 'empty' ? [] : charsList();
  const name = query.char && CHARS[query.char] ? query.char : chars[0]?.name;
  const c = name ? CHARS[name] : null;
  const { plan: _plan, ...character } = c || {};
  const plan = c ? planJson(c) : null;
  const officer = ['owner', 'officer'].includes(myRole(state));
  return {
    characters: chars,
    character: c ? character : null,
    plan,
    planBusy: Boolean(c && ((c.name === 'Shadowfen' && planBusyUntil) || MODE === 'busy')),
    nextSteps: c ? nextSteps(c, plan) : [],
    questions: c ? QUESTIONS.map(({ _t, ...q }) => q) : [],
    limits: { questionsPerDay: 30, plansPerDay: 5, questionsLeft: 30 - QUESTIONS.filter((q) => q.source === 'app').length, plansLeft: 4 },
    ai: AI[MODE] || { available: true, hasKey: true, enabled: true, budgetLeft: true, reason: null },
    usage: officer ? { month: new Date().toISOString().slice(0, 7), spentUsd: 1.8423, budgetUsd: 15, questions: 87, plans: 12 } : null,
  };
}

addMockRoutes({
  'GET /api/coach': view,
  'POST /api/coach/ask': ({ body = {}, state }) => {
    if (!state.inGuild) throw httpError(403, 'Join a guild first.');
    const question = String(body.question || '').trim().slice(0, 500);
    if (!question) throw httpError(400, 'Type a question first.');
    const q = { id: nextId++, char_name: CHARS[body.char] ? body.char : 'Grimtusk', source: 'app', question, answer: null, sources: [],
      status: 'pending', error: null, created_at: sqlTime(), answered_at: null, _t: Date.now() };
    QUESTIONS.unshift(q);
    const { _t, ...out } = q;
    return { question: out, message: "The Coach is still thinking. The answer shows here when it's ready." };
  },
  'POST /api/coach/plan': ({ body = {} }) => {
    const c = CHARS[body.char] || CHARS.Grimtusk;
    if (c.name === 'Shadowfen' && !c.plan) {
      planBusyUntil = Date.now() + 5000;
      return { status: 'pending', char: c.name, message: "The Coach is writing your plan. It can take a minute; it shows here when it's ready." };
    }
    c.plan = { ...c.plan, at: unix() };
    c.plan_at = sqlTime();
    return { status: 'ready', char: c.name, plan: planJson(c), message: 'Your new build plan is ready. It reaches the game after your next sync and /reload.' };
  },
});
