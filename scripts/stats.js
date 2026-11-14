// stats.js — on-device game history, daily streaks, and the stats panel markup.
import { getDayNumber, getGrade, MAX_TOTAL_SCORE } from './gameLogic.js';

const HISTORY_KEY = 'bpmguesser_history';
const HISTORY_CAP = 500;
const DAILY_KEY_PREFIX = 'bpmguesser_daily_';

// ── Daily result keys (one per local calendar date) ────────────────────────
export function getDailyKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${DAILY_KEY_PREFIX}${y}${m}${d}`;
}

function dateFromDailyKey(key) {
  const m = /^bpmguesser_daily_(\d{4})(\d{2})(\d{2})$/.exec(key);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / blocked — stats are best-effort */
  }
}

function dailyKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DAILY_KEY_PREFIX)) keys.push(k);
    }
  } catch {
    /* ignore */
  }
  return keys;
}

// ── Streaks ────────────────────────────────────────────────────────────────
/** Current and best consecutive-day Daily Challenge streaks, from stored daily results. */
export function getStreaks(today = getDayNumber()) {
  const days = new Set(
    dailyKeys()
      .map(dateFromDailyKey)
      .filter(Boolean)
      .map((d) => getDayNumber(d)),
  );
  let current = 0;
  let cursor = days.has(today) ? today : today - 1; // today not played yet keeps yesterday's streak alive
  while (days.has(cursor)) {
    current++;
    cursor--;
  }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort((a, b) => a - b)) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best };
}

// ── History ────────────────────────────────────────────────────────────────
/** Seed history from pre-existing daily results so returning players start with stats. */
function migrateHistory() {
  const history = dailyKeys()
    .map((key) => {
      const date = dateFromDailyKey(key);
      const r = readJSON(key);
      if (!date || !r || typeof r.score !== 'number') return null;
      return {
        t: date.getTime(),
        mode: 'daily',
        day: getDayNumber(date),
        score: r.score,
        rounds: (r.results || []).map((x) => ({ a: x.actualBPM, g: x.guessedBPM, s: x.score })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  writeJSON(HISTORY_KEY, history);
  return history;
}

export function loadHistory() {
  const h = readJSON(HISTORY_KEY);
  return Array.isArray(h) ? h : migrateHistory();
}

export function recordGame({ mode, day, score, results }) {
  const history = loadHistory();
  history.push({
    t: Date.now(),
    mode,
    day: mode === 'daily' ? day : undefined,
    score,
    rounds: results.map((r) => ({ a: r.actualBPM, g: r.guessedBPM, s: r.score })),
  });
  writeJSON(HISTORY_KEY, history.slice(-HISTORY_CAP));
}

// ── Stats panel ────────────────────────────────────────────────────────────
const GRADES = ['S', 'A', 'B', 'C', 'F'];
const RECENT_N = 20;

function computeStats(history) {
  // Rounds with actualBPM 0 are placeholders for games quit before any guess.
  const rounds = history.flatMap((g) => g.rounds || []).filter((r) => r.a > 0 && r.g > 0);
  const errors = rounds.map((r) => Math.abs(r.a - r.g));
  const gradeCounts = Object.fromEntries(GRADES.map((g) => [g, 0]));
  rounds.forEach((r) => gradeCounts[getGrade(r.s)]++);
  const scores = history.map((g) => g.score);
  return {
    played: history.length,
    best: scores.length ? Math.max(...scores) : 0,
    average: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
    avgError: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    exact: errors.filter((e) => e === 0).length,
    gradeCounts,
    roundCount: rounds.length,
    recent: history.slice(-RECENT_N),
  };
}

function tile(label, value, sub = '') {
  return `<div class="stats-tile">
      <span class="stats-tile__label">${label}</span>
      <span class="stats-tile__figure">
        <span class="stats-tile__value">${value}</span>
        ${sub ? `<span class="stats-tile__sub">${sub}</span>` : ''}
      </span>
    </div>`;
}

/** Markup for the stats view body (the panel supplies the heading). */
export function renderStatsHTML() {
  const history = loadHistory();
  const streaks = getStreaks();

  if (!history.length) {
    return `<p class="stats-empty">Play a game to start tracking your stats.</p>`;
  }

  const s = computeStats(history);
  const tiles = [
    tile('Played', s.played),
    tile('Best', s.best.toFixed(2)),
    tile('Average', s.average.toFixed(2)),
    tile('Avg. error', s.avgError === null ? '—' : `${s.avgError.toFixed(1)}<small> bpm</small>`),
    tile('Exact guesses', s.exact),
    tile(
      'Daily streak',
      `${streaks.current}${streaks.current >= 2 ? ' <i class="ph-fill ph-fire stats-fire" aria-hidden="true"></i>' : ''}`,
      `Best ${streaks.best}`,
    ),
  ].join('');

  const maxCount = Math.max(1, ...Object.values(s.gradeCounts));
  const gradeRows = GRADES.map((g) => {
    const n = s.gradeCounts[g];
    const pct = (n / maxCount) * 100;
    return `<div class="grade-bars__row" title="${n} round${n === 1 ? '' : 's'} graded ${g}">
        <span class="grade-bars__label">${g}</span>
        <span class="grade-bars__track"><span class="grade-bars__fill" style="width:${pct}%"></span></span>
        <span class="grade-bars__value">${n}</span>
      </div>`;
  }).join('');

  const recentBest = Math.max(...s.recent.map((g) => g.score));
  const cols = s.recent
    .map((g) => {
      const h = Math.max(2, (g.score / MAX_TOTAL_SCORE) * 100);
      const label = `${g.mode === 'daily' && g.day ? `Daily #${g.day}` : 'Quick Play'} · ${g.score.toFixed(2)}`;
      const isBest = g.score === recentBest;
      return `<span class="recent-chart__col${isBest ? ' is-best' : ''}" title="${label}" style="height:${h}%">${
        isBest ? `<span class="recent-chart__tag">${g.score.toFixed(0)}</span>` : ''
      }</span>`;
    })
    .join('');
  const summary = s.recent.map((g) => g.score.toFixed(0)).join(', ');

  // Each top-level block is a direct child of .panel-body so the panel can stagger them in.
  return `<div class="stats-grid">${tiles}</div>
    <h4>Round grades</h4>
    <div class="grade-bars">${gradeRows}</div>
    <h4>Last ${s.recent.length} game${s.recent.length === 1 ? '' : 's'}</h4>
    <div class="recent-chart" role="img" aria-label="Scores out of ${MAX_TOTAL_SCORE}, oldest to newest: ${summary}">${cols}</div>
    <p class="stats-note">Stats are stored on this device.</p>`;
}
