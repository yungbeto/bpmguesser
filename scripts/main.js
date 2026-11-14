// main.js
import {
  getHighScores,
  addHighScore,
  getDailyHighScores,
  addDailyHighScore,
  LEADERBOARD_TOP_N,
  initFirebaseAnalytics,
  warmUpFirebase,
} from './firebase.js';
import {
  calculateScoreBreakdown,
  generateRandomBPM,
  TIME_PENALTY_THRESHOLD,
  TOTAL_ROUNDS,
  MAX_TOTAL_SCORE,
  BPM_RANGES,
  getGrade,
  getGameGrade,
  getDayNumber,
  generateDailyBPMs,
} from './gameLogic.js';
import {
  ensureAudio,
  getAudioContext,
  playMetronomeSound,
  updateVisualMetronome,
  changeBackgroundColor,
} from './audioVisual.js';
import { celebrate } from './confetti.js';
import { getDailyKey, getStreaks, recordGame, renderStatsHTML } from './stats.js';

const NAME_MAX = 24;
const URL_MAX = 200;

let actualBPM,
  startTime,
  timerInterval,
  countInterval,
  intermissionInterval;
let schedulerTimeout = null; // non-null while a metronome is running
let nextBeatTime = 0;
let gameMode = 'quick'; // 'quick' | 'daily'
let dailyBPMs = [];
let dailyDate = null; // local date the current daily run started (pins key + day number across midnight)
let dailyDay = null;
let qualifiesAllTime = false;
let qualifiesDaily = false;
let pendingRanks = { alltime: null, daily: null }; // rank the score would take, from the qualification check
let submittedBoards = { alltime: false, daily: false }; // so a retry never double-posts
let myRank = null; // { alltime, daily } after a successful submission
let mySubmittedScore = null; // { name, score } set after a successful high score submission
let roundRevealed = false; // true once the first metronome of this game has started
let gameRecorded = false;

const LOOKAHEAD = 0.1; // seconds ahead to schedule audio
const SCHEDULE_INTERVAL = 25; // ms between scheduler checks
let currentBeat = 0;
let currentRound = 1;
let totalScore = 0;
let roundResults = [];
let isCountdownActive = false;

// DOM elements
const gameArea = document.getElementById('game-area');
const endScreen = document.getElementById('end-screen');
const countdownArea = document.querySelector('#countdown-screen .countdown');
const intermissionArea = document.querySelector(
  '#intermission-screen .intermission',
);
const timerDisplay = document.getElementById('timer');
const circle1 = document.querySelector('.game-container #circle1');
const bpmGuessInput = document.querySelector('.game-container #bpm-guess');
const endGameButton = document.getElementById('end-game');
const submitGuessButton = document.getElementById('submit-guess');
const timerPenaltyEl = document.getElementById('timer-penalty');

// ── Game-scoped timers ──────────────────────────────────────────────────────
// Every one-shot timeout tied to a running game goes through `later` so quitting
// can cancel all of them (no metronome starting on the results screen).
const gameTimers = new Set();
function later(fn, ms) {
  const id = setTimeout(() => {
    gameTimers.delete(id);
    fn();
  }, ms);
  gameTimers.add(id);
  return id;
}
function clearGameTimers() {
  gameTimers.forEach(clearTimeout);
  gameTimers.clear();
}

const IN_GAME_SCREENS = ['countdown-screen', 'intermission-screen', 'game-area'];
function isGameInProgress() {
  return IN_GAME_SCREENS.some((id) =>
    document.getElementById(id)?.classList.contains('active'),
  );
}

// ── Cookie consent ──────────────────────────────────────────────────────────
const CONSENT_STORAGE_KEY = 'bpmguesser_consent';
const CONSENT_LEGACY_KEY = 'bpmguesser_cookies_accepted';

function getCookieConsent() {
  const c = localStorage.getItem(CONSENT_STORAGE_KEY);
  if (c === 'analytics' || c === 'essential') {
    return c;
  }
  if (localStorage.getItem(CONSENT_LEGACY_KEY) === '1') {
    return 'analytics';
  }
  return null;
}

function setCookieConsent(mode) {
  localStorage.setItem(CONSENT_STORAGE_KEY, mode);
  if (localStorage.getItem(CONSENT_LEGACY_KEY)) {
    localStorage.removeItem(CONSENT_LEGACY_KEY);
  }
}

function initCookieBanner() {
  if (getCookieConsent() === 'analytics') {
    initFirebaseAnalytics();
  }

  if (getCookieConsent() !== null) {
    return;
  }

  const banner = document.getElementById('cookie-banner');
  banner.style.display = 'flex';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => banner.classList.add('is-visible')),
  );

  const closeBanner = () => {
    banner.classList.remove('is-visible');
    banner.addEventListener(
      'transitionend',
      () => {
        banner.style.display = 'none';
      },
      { once: true },
    );
  };

  document.getElementById('accept-cookies').addEventListener('click', () => {
    setCookieConsent('analytics');
    initFirebaseAnalytics();
    closeBanner();
  });
  document
    .getElementById('accept-cookies-essential')
    .addEventListener('click', () => {
      setCookieConsent('essential');
      closeBanner();
    });
}

// ── Local persistence ───────────────────────────────────────────────────────
function getPersonalBest() {
  const val = localStorage.getItem('bpmguesser_pb');
  return val !== null ? parseFloat(val) : null;
}

function setPersonalBest(score) {
  localStorage.setItem('bpmguesser_pb', score.toString());
}

function getDailyResult(date = new Date()) {
  try {
    return JSON.parse(localStorage.getItem(getDailyKey(date)));
  } catch {
    return null;
  }
}

/**
 * Saved as soon as round 1's tempo is heard (inProgress), after every round, and
 * at the end — so refreshing mid-run can't buy a replay with known answers.
 */
function saveDailyResult(score, results, { inProgress = false } = {}) {
  localStorage.setItem(
    getDailyKey(dailyDate || new Date()),
    JSON.stringify({ score, results, inProgress }),
  );
}

// ── Sharing ─────────────────────────────────────────────────────────────────
/**
 * Accuracy-only emoji, so the row lines up with the "Off by" line beneath it
 * (grades also include the speed bonus, which made 🎯 mean "fast", not "exact").
 * 20+ off scores zero for the round (MAX_BPM_DIFFERENCE in gameLogic.js).
 */
function accuracyEmoji(r) {
  if (!(r.guessedBPM > 0)) return '⬛';
  const diff = Math.abs(r.actualBPM - r.guessedBPM);
  if (diff === 0) return '🎯';
  if (diff <= 3) return '🟩';
  if (diff <= 10) return '🟨';
  if (diff < 20) return '🟧';
  return '⬛';
}

function buildShareText({ mode, day, results, total }) {
  const header =
    mode === 'daily' ? `🎵 BPM Guesser Daily #${day}` : '🎵 BPM Guesser';
  const emoji = results.map(accuracyEmoji).join(' ');
  const offs = results
    .map((r) =>
      r.guessedBPM > 0 ? String(Math.abs(r.actualBPM - r.guessedBPM)) : '–',
    )
    .join(' · ');
  const lines = [
    header,
    `${emoji}  ${total.toFixed(2)}/${MAX_TOTAL_SCORE}`,
    `Off by ${offs} BPM`,
  ];
  if (mode === 'daily') {
    const { current } = getStreaks();
    if (current >= 2) lines.push(`🔥 ${current}-day streak`);
  }
  lines.push('https://bpmga.me');
  return lines.join('\n');
}

/** Native share sheet on touch devices, clipboard elsewhere. */
function prefersShareSheet() {
  return (
    typeof navigator.share === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

async function shareText(text) {
  if (prefersShareSheet()) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      // otherwise fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

// ── Daily status (home) ─────────────────────────────────────────────────────
let shownDayNumber = null;

function formatUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const mins = Math.max(1, Math.ceil((midnight - now) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function updateDailyEyebrow() {
  const result = getDailyResult();
  const eyebrowSep = document.getElementById('daily-eyebrow-sep');
  const eyebrowNext = document.getElementById('daily-eyebrow-thanks');
  const streakEl = document.getElementById('daily-eyebrow-streak');
  if (eyebrowSep) eyebrowSep.textContent = result ? '·' : '';
  if (eyebrowNext)
    eyebrowNext.textContent = result ? `Next in ${formatUntilMidnight()}` : '';
  if (streakEl) {
    const { current } = getStreaks();
    streakEl.hidden = current < 2;
    const n = streakEl.querySelector('.daily-eyebrow-streak__count');
    if (n) n.textContent = current;
    streakEl.setAttribute('aria-label', `${current}-day streak`);
  }
}

function updateDailyStatus() {
  shownDayNumber = getDayNumber();
  const dayNumberEl = document.getElementById('day-number');
  if (dayNumberEl) dayNumberEl.textContent = `#${shownDayNumber}`;

  const result = getDailyResult();
  const dailyBtn = document.getElementById('start-daily');
  if (!dailyBtn) return;

  const tooltip = document.querySelector('.daily-tooltip');
  if (tooltip)
    tooltip.textContent = prefersShareSheet() ? 'Share result' : 'Copy details';

  if (result) {
    dailyBtn.classList.add('is-played');
    dailyBtn.innerHTML = `
            <span class="home-daily-label">Daily Challenge</span>
            <span class="home-daily-score-container">
                <span class="home-daily-score-details">
                    <span class="home-daily-score-label">Your score</span>
                    <span class="home-daily-score-value">${Number(result.score || 0).toFixed(2)}</span>
                </span>
                <i class="ph-bold ph-check home-daily-check"></i>
                <i class="ph-bold ${prefersShareSheet() ? 'ph-export' : 'ph-copy'} home-daily-copy"></i>
            </span>
        `;
  } else {
    dailyBtn.classList.remove('is-played');
    dailyBtn.innerHTML = `
            <span class="home-daily-label">Daily Challenge</span>
            <i class="ph-bold ph-arrow-right"></i>
        `;
  }
  updateDailyEyebrow();
}

/** Keeps "Next in …" fresh and rolls the home screen over at local midnight. */
function startDailyClock() {
  const tick = () => {
    if (!document.getElementById('home-screen').classList.contains('active')) return;
    if (getDayNumber() !== shownDayNumber) updateDailyStatus();
    else updateDailyEyebrow();
  };
  setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

// ── Theme ───────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const iconLight = document.getElementById('theme-icon-light');
  const iconDark = document.getElementById('theme-icon-dark');
  iconLight?.classList.toggle('is-hidden', dark);
  iconDark?.classList.toggle('is-hidden', !dark);
}

(function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved ? saved === 'dark' : prefersDark);
})();

document.addEventListener('DOMContentLoaded', () => {
  // Sync theme icons now that DOM is ready
  applyTheme(document.documentElement.dataset.theme === 'dark');

  document.getElementById('total-rounds').textContent = TOTAL_ROUNDS;
  updateDailyStatus();
  startDailyClock();
  initCookieBanner();
  showScreen('home-screen', { focusHeading: false });

  // Fetch Firebase in the background once the page is idle (it's off the critical path).
  (window.requestIdleCallback || ((cb) => setTimeout(cb, 1500)))(warmUpFirebase);

  document.getElementById('start-daily').addEventListener('click', async () => {
    const existingResult = getDailyResult();
    if (existingResult) {
      await shareDailyResult(existingResult);
      return;
    }
    ensureAudio(); // inside the click gesture, so the browser lets audio play
    gameMode = 'daily';
    dailyDate = new Date();
    dailyDay = getDayNumber(dailyDate);
    dailyBPMs = generateDailyBPMs(dailyDay);
    beginGame();
  });

  document.getElementById('start-game').addEventListener('click', () => {
    ensureAudio();
    gameMode = 'quick';
    dailyDate = null;
    dailyDay = null;
    beginGame();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (isGameInProgress()) {
        endGame();
      } else if (
        document.getElementById('home-screen').classList.contains('active') &&
        document.getElementById('home-wrapper').classList.contains('scores-open')
      ) {
        toggleHomeScores();
      }
    }
    if (event.key === ' ' && gameArea.classList.contains('active')) {
      event.preventDefault();
      submitGuess();
    }
  });

  submitGuessButton.addEventListener('click', submitGuess);
  document
    .getElementById('submit-score-check')
    .addEventListener('click', submitHighScoreCheck);
  for (const id of ['player-name-check', 'player-url-check']) {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitHighScoreCheck();
      }
    });
  }
  document
    .getElementById('continue-to-final')
    .addEventListener('click', showFinalScreen);
  document.getElementById('skip-high-score').addEventListener('click', () => {
    document.getElementById('skip-high-score').disabled = true;
    showFinalScreen();
  });
  document.getElementById('play-again').addEventListener('click', () => resetGame());
  document.getElementById('go-home').addEventListener('click', () => resetGame());
  document
    .getElementById('end-toggle-scores')
    .addEventListener('click', toggleEndScores);
  document
    .getElementById('close-scores-end')
    .addEventListener('click', toggleEndScores);

  document.getElementById('round-results').addEventListener('click', (e) => {
    const btn = e.target.closest('.round-result-top');
    if (!btn) return;
    const card = btn.closest('.round-result');
    const wrap = card?.querySelector('.result-details-wrap');
    if (!wrap) return;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    const next = !expanded;
    btn.setAttribute('aria-expanded', String(next));
    wrap.setAttribute('aria-hidden', String(!next));
    btn.setAttribute(
      'aria-label',
      next ? 'Hide round details' : 'Show round details',
    );

    if (next) {
      // Un-hide, force reflow so the browser sees 0fr before transitioning to 1fr
      wrap.style.display = 'grid';
      void wrap.offsetWidth;
      card.classList.add('is-open');
    } else {
      card.classList.remove('is-open');
      wrap.addEventListener(
        'transitionend',
        () => {
          if (!card.classList.contains('is-open')) wrap.style.display = 'none';
        },
        { once: true },
      );
    }
  });

  bpmGuessInput.addEventListener('keypress', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitGuess();
    }
  });
  bpmGuessInput.addEventListener(
    'wheel',
    function (event) {
      event.preventDefault();
    },
    { passive: false },
  );

  endGameButton.addEventListener('click', endGame);

  document.getElementById('toggle-theme').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
    applyTheme(!isDark);
  });

  (function attachDailyBtnGlow() {
    const btn = document.getElementById('start-daily');
    if (!btn) return;
    btn.addEventListener('mousemove', (e) => {
      const r = btn.getBoundingClientRect();
      btn.style.setProperty(
        '--mouse-x',
        `${((e.clientX - r.left) / r.width) * 100}%`,
      );
      btn.style.setProperty(
        '--mouse-y',
        `${((e.clientY - r.top) / r.height) * 100}%`,
      );
    });
  })();

  // Scores / stats / about all open in the same off-canvas panel.
  document.querySelectorAll('[data-panel-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => openPanelView(btn.dataset.panelToggle));
  });
  document
    .getElementById('close-scores')
    .addEventListener('click', () => toggleHomeScores());

  document
    .getElementById('tab-alltime')
    .addEventListener('click', () => switchScoreTab('alltime'));
  document
    .getElementById('tab-today')
    .addEventListener('click', () => switchScoreTab('today'));

  document
    .getElementById('tab-alltime-end')
    .addEventListener('click', () => switchEndScoreTab('alltime'));
  document
    .getElementById('tab-today-end')
    .addEventListener('click', () => switchEndScoreTab('today'));

  initHighScoreStickyTabs();
  initGuessTyper();

  // Open scores panel by default on desktop (no entrance animation on first paint)
  if (!isMobileScoresLayout()) {
    toggleHomeScores({ instant: true });
  }
});

function showScreen(screenId, options = {}) {
  const { focusHeading = true } = options;

  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.remove('active');
    screen.style.display = 'none';
  });

  const activeScreen = document.getElementById(screenId);
  activeScreen.classList.add('active');
  activeScreen.style.display = 'flex';
  activeScreen.style.opacity = '';
  activeScreen.scrollTop = 0;

  document.body.style.overflow = screenId === 'game-area' ? 'hidden' : '';

  // Move focus to the first heading for screen reader context.
  // game-area manages its own focus via bpmGuessInput.focus() in startRound().
  if (focusHeading && screenId !== 'game-area') {
    const heading = activeScreen.querySelector('h1, h2, h3');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

// ── How to Play: step 02 glyph types sample guesses ─────────────────────────
/** Types/backspaces a few tempos in the mini field. Runs only while it's on screen. */
function initGuessTyper() {
  const el = document.querySelector('.how-guess__value');
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const values = ['120', '96', '143', '108'];
  let idx = 0;
  let run = 0; // bumps on every start/stop so a stale loop exits on its next tick
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loop(id) {
    el.textContent = '';
    await sleep(400);
    while (id === run) {
      const v = values[idx++ % values.length];
      for (let i = 1; i <= v.length && id === run; i++) {
        el.textContent = v.slice(0, i);
        await sleep(120 + Math.random() * 80); // human-ish typing cadence
      }
      await sleep(1600);
      for (let i = v.length - 1; i >= 0 && id === run; i--) {
        el.textContent = v.slice(0, i);
        await sleep(55);
      }
      await sleep(350);
    }
  }

  new IntersectionObserver(([entry]) => {
    run++;
    if (entry.isIntersecting) void loop(run);
    else el.textContent = '120';
  }).observe(el);
}

// ── Game flow ───────────────────────────────────────────────────────────────
function resetRunState() {
  currentRound = 1;
  totalScore = 0;
  roundResults = [];
  roundRevealed = false;
  gameRecorded = false;
  qualifiesAllTime = false;
  qualifiesDaily = false;
  pendingRanks = { alltime: null, daily: null };
  submittedBoards = { alltime: false, daily: false };
  myRank = null;
  mySubmittedScore = null;
}

function beginGame() {
  resetRunState();
  showScreen('countdown-screen');
  startGameCountdown();
}

function startGameCountdown() {
  endGameButton.style.display = 'block';
  // Ensure home scores panel is closed before game starts
  const wrapper = document.getElementById('home-wrapper');
  if (wrapper && wrapper.classList.contains('scores-open')) {
    toggleHomeScores({ instant: true });
  }
  changeBackgroundColor(true);
  let count = 3;
  countdownArea.textContent = 'Get ready...';
  triggerAnim(countdownArea, 'pop');
  isCountdownActive = true;

  countInterval = setInterval(() => {
    if (count > 0) {
      countdownArea.textContent = count;
      triggerAnim(countdownArea, 'pop');
      count--;
    } else {
      clearInterval(countInterval);
      changeBackgroundColor(false);
      isCountdownActive = false;
      startRound();
    }
  }, 1000);
}

function startRound() {
  showScreen('game-area');

  const dailyIndicator = document.getElementById('daily-game-indicator');
  if (dailyIndicator) {
    if (gameMode === 'daily') {
      document.getElementById('daily-game-day-number').textContent =
        `#${dailyDay}`;
      dailyIndicator.style.display = '';
    } else {
      dailyIndicator.style.display = 'none';
    }
  }

  later(() => {
    const currentRoundDisplay = document.getElementById('current-round');
    if (!currentRoundDisplay) return;

    currentRoundDisplay.textContent = currentRound;
    actualBPM =
      gameMode === 'daily'
        ? dailyBPMs[currentRound - 1]
        : generateRandomBPM(currentRound);

    const { min, max } =
      BPM_RANGES[Math.min(currentRound - 1, BPM_RANGES.length - 1)];
    const hintEl = document.getElementById('bpm-range-hint');
    if (hintEl) hintEl.textContent = `${min} – ${max} BPM`;

    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);

    resetCircles();
    bpmGuessInput.value = '';
    submitGuessButton.disabled = false;
    timerDisplay.textContent = '0';
    timerDisplay.classList.remove('penalized');
    timerPenaltyEl.textContent = '';
    gameArea.style.backgroundColor = '';

    if (currentRound === 1) {
      const runningScoreEl = document.getElementById('running-score');
      if (runningScoreEl) runningScoreEl.style.display = 'none';
    }

    later(() => {
      bpmGuessInput.focus();
      bpmGuessInput.select();
    }, 500);

    if (!roundRevealed) {
      roundRevealed = true;
      // The tempo is now audible: from here on, today's daily counts as played.
      if (gameMode === 'daily') saveDailyResult(0, [], { inProgress: true });
    }
    startMetronome();
  }, 300);
}

function startMetronome() {
  const audioCtx = ensureAudio();
  nextBeatTime = audioCtx.currentTime;
  currentBeat = 0;
  schedulerTick();
}

function schedulerTick() {
  const audioCtx = getAudioContext();
  const secondsPerBeat = 60 / actualBPM;

  while (nextBeatTime < audioCtx.currentTime + LOOKAHEAD) {
    const beat = currentBeat;
    playMetronomeSound(nextBeatTime, beat % 2 === 0);

    const visualDelay = Math.max(
      0,
      (nextBeatTime - audioCtx.currentTime) * 1000,
    );
    later(() => updateVisualMetronome(circle1), visualDelay);

    nextBeatTime += secondsPerBeat;
    currentBeat++;
  }

  schedulerTimeout = setTimeout(schedulerTick, SCHEDULE_INTERVAL);
}

function stopMetronome() {
  clearTimeout(schedulerTimeout);
  schedulerTimeout = null;
  clearGameTimers(); // pending pulses + round-start/focus timers
  resetCircles();
}

function resetCircles() {
  circle1.classList.remove('beat-pulse');
}

function submitGuess() {
  if (submitGuessButton.disabled || schedulerTimeout === null) return;
  const guessedBPM = parseInt(bpmGuessInput.value);
  if (isNaN(guessedBPM) || guessedBPM <= 0) {
    bpmGuessInput.classList.add('input-error');
    bpmGuessInput.focus();
    setTimeout(() => bpmGuessInput.classList.remove('input-error'), 600);
    return;
  }

  submitGuessButton.disabled = true;
  clearInterval(timerInterval);
  stopMetronome();
  gameArea.style.backgroundColor = '';

  const timeTaken = (Date.now() - startTime) / 1000;
  const breakdown = calculateScoreBreakdown(actualBPM, guessedBPM, timeTaken);
  const roundScore = breakdown.finalScore;
  totalScore += roundScore;

  roundResults.push({
    round: currentRound,
    actualBPM,
    guessedBPM,
    score: roundScore,
    timeTaken,
    speedBonus: breakdown.speedBonus,
    timePenalty: breakdown.timePenalty,
  });

  if (gameMode === 'daily') {
    saveDailyResult(totalScore, roundResults, {
      inProgress: currentRound < TOTAL_ROUNDS,
    });
  }

  const runningScoreEl = document.getElementById('running-score');
  const runningScoreValue = document.getElementById('running-score-value');
  if (runningScoreEl && runningScoreValue) {
    runningScoreValue.textContent = totalScore.toFixed(2);
    runningScoreEl.style.display = 'block';
  }

  showIntermission();
}

function tempoCompareHTML({ actualBPM: actual, guessedBPM: guess }) {
  if (!(actual > 0 && guess > 0)) return '';
  // Clamp absurd guesses so the pulse stays a readable blink.
  const beat = (bpm) => Math.max(0.12, 60 / bpm).toFixed(4);
  return `<div class="tempo-compare" aria-hidden="true">
        <div class="tempo-compare__item">
            <span class="tempo-dot" style="--beat:${beat(actual)}s"></span>
            <span class="tempo-compare__label">Actual</span>
            <span class="tempo-compare__bpm">${actual}</span>
        </div>
        <div class="tempo-compare__item">
            <span class="tempo-dot tempo-dot--guess" style="--beat:${beat(guess)}s"></span>
            <span class="tempo-compare__label">You</span>
            <span class="tempo-compare__bpm">${guess}</span>
        </div>
    </div>`;
}

function showIntermission() {
  showScreen('intermission-screen');
  changeBackgroundColor(true);

  const isLastRound = currentRound === TOTAL_ROUNDS;
  const lastResult = roundResults[roundResults.length - 1];
  const bpmDiff = Math.abs(lastResult.actualBPM - lastResult.guessedBPM);
  const grade = getGrade(lastResult.score);
  let diffText = bpmDiff === 0 ? 'Exact!' : `Off by ${bpmDiff}`;
  if (bpmDiff > 0) {
    diffText +=
      lastResult.guessedBPM < lastResult.actualBPM
        ? ' · ↑ too low'
        : ' · ↓ too high';
  }

  const nextSection = isLastRound
    ? `<div class="intermission-next">
               <p class="intermission-headline">Tallying results…</p>
           </div>`
    : `<div class="intermission-next">
               <p class="intermission-headline">Get ready for round ${currentRound + 1}</p>
               <p class="intermission-countdown">3</p>
           </div>`;

  const speedBonus = lastResult.speedBonus ?? 0;
  const bonusHTML = speedBonus > 0
    ? `<div class="intermission-bonus" id="intermission-bonus">
           <i class="ph-fill ph-lightning" aria-hidden="true"></i>
           +${speedBonus.toFixed(2)} speed bonus
       </div>`
    : '';

  let count = 3;
  intermissionArea.innerHTML = `
        <div class="intermission-result">
            <span class="intermission-round-label">Round ${currentRound}</span>
            <div class="intermission-score-row">
                <span class="intermission-score" id="intermission-score-value">0.00</span>
                <span class="intermission-grade grade-${grade}">${grade}</span>
            </div>
            ${bonusHTML}
            <span class="intermission-detail">${diffText}</span>
            ${tempoCompareHTML(lastResult)}
        </div>
        <div class="intermission-separator"></div>
        ${nextSection}
    `;

  const scoreEl = document.getElementById('intermission-score-value');
  if (scoreEl) animateCount(scoreEl, lastResult.score);

  if (speedBonus > 0) {
    later(() => {
      document.getElementById('intermission-bonus')?.classList.add('is-visible');
    }, 350);
  }

  if (bpmDiff === 0) later(() => celebrate({ originY: 0.3 }), 250);

  intermissionInterval = setInterval(() => {
    count--;
    const countdownEl = document.querySelector('.intermission-countdown');
    if (count > 0) {
      if (countdownEl) {
        countdownEl.textContent = count;
        triggerAnim(countdownEl, 'tick');
      }
    } else {
      clearInterval(intermissionInterval);
      changeBackgroundColor(false);
      if (isLastRound) {
        showFinalResults();
      } else {
        currentRound++;
        startRound();
      }
    }
  }, 1000);
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  timerDisplay.textContent = elapsed;

  if (elapsed >= TIME_PENALTY_THRESHOLD) {
    timerDisplay.classList.add('penalized');
    const penalty = Math.max(0, (elapsed - TIME_PENALTY_THRESHOLD) * 0.5);
    timerPenaltyEl.textContent =
      penalty > 0 ? `−${penalty.toFixed(1)} pts` : '−0.5 pts/s';

    const urgency = Math.min((elapsed - TIME_PENALTY_THRESHOLD) / 20, 1);
    gameArea.style.backgroundColor = `rgba(239, 68, 68, ${(urgency * 0.1).toFixed(3)})`;
  }
}

function endGame() {
  if (!isGameInProgress()) return;

  stopMetronome();
  clearInterval(timerInterval);
  clearInterval(intermissionInterval);
  clearInterval(countInterval);
  isCountdownActive = false;
  endGameButton.style.display = 'none';
  changeBackgroundColor(false);

  // Quitting before any guess: Quick Play just goes home. A daily whose tempo was
  // already heard is recorded as 0 (otherwise quitting would be a free peek).
  if (roundResults.length === 0 && (gameMode === 'quick' || !roundRevealed)) {
    resetGame({ immediate: true });
    return;
  }

  if (roundResults.length === 0) {
    roundResults.push({
      round: 1,
      actualBPM: actualBPM || 0,
      guessedBPM: 0,
      score: 0,
      timeTaken: 0,
      speedBonus: 0,
      timePenalty: 0,
    });
  }

  showFinalResults();
}

function showFinalResults() {
  endGameButton.style.display = 'none';
  if (gameMode === 'daily') saveDailyResult(totalScore, roundResults);
  document.getElementById('final-score-check').textContent =
    totalScore.toFixed(2);
  checkAndHandleHighScore();
}

/** Would `score` make a top-N list? Returns the rank it would take, or null. */
function rankIn(entries, score) {
  if (!(score > 0)) return null;
  const rank = entries.filter((e) => e.score >= score).length + 1;
  return rank <= LEADERBOARD_TOP_N ? rank : null;
}

async function checkAndHandleHighScore() {
  try {
    const [alltime, daily] = await Promise.all([
      getHighScores(),
      gameMode === 'daily' ? getDailyHighScores(dailyDay) : Promise.resolve(null),
    ]);
    pendingRanks = {
      alltime: rankIn(alltime, totalScore),
      daily: daily ? rankIn(daily, totalScore) : null,
    };
    qualifiesAllTime = pendingRanks.alltime !== null;
    qualifiesDaily = pendingRanks.daily !== null;

    showScreen('high-score-check');
    setFormError('');
    document.getElementById('skip-high-score').disabled = false;

    if (qualifiesAllTime || qualifiesDaily) {
      let subtitleText;
      if (qualifiesAllTime && qualifiesDaily)
        subtitleText = 'You got an all-time and daily high score!';
      else if (qualifiesAllTime)
        subtitleText = 'You got an all-time high score!';
      else subtitleText = 'You got a daily high score!';
      const subtitleEl = document.querySelector(
        '#high-score-input-area .hero-subtitle',
      );
      if (subtitleEl) subtitleEl.textContent = subtitleText;

      document.getElementById('high-score-input-area').style.display = 'flex';
      document.getElementById('no-high-score-area').style.display = 'none';
      const nameInput = document.getElementById('player-name-check');
      nameInput.value = localStorage.getItem('bpmguesser_last_name') || '';
      document.getElementById('player-url-check').value =
        localStorage.getItem('bpmguesser_last_url') || '';
      nameInput.focus({ preventScroll: true });
    } else {
      document.getElementById('high-score-input-area').style.display = 'none';
      document.getElementById('no-high-score-area').style.display = 'flex';
    }
  } catch (error) {
    console.error('Error checking high score:', error);
    showFinalScreen();
  }
}

function setFormError(message, focusEl = null) {
  const el = document.getElementById('score-form-error');
  if (el) el.textContent = message;
  if (focusEl) {
    focusEl.focus();
    focusEl.classList.add('input-error');
    setTimeout(() => focusEl.classList.remove('input-error'), 600);
  }
}

/** Parse a player-supplied URL (with or without scheme). Returns a URL or null. */
function parseUserUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    return u;
  } catch {
    return null;
  }
}

async function submitHighScoreCheck() {
  const nameInput = document.getElementById('player-name-check');
  const urlInput = document.getElementById('player-url-check');
  const submitButton = document.getElementById('submit-score-check');
  if (submitButton.style.display === 'none') return; // already submitting

  const playerName = nameInput.value.trim().replace(/\s+/g, ' ');
  const rawUrl = urlInput.value.trim();

  if (!playerName) return setFormError('Please enter your name.', nameInput);
  if (playerName.length > NAME_MAX)
    return setFormError(`Names can be up to ${NAME_MAX} characters.`, nameInput);

  let playerUrl = '';
  if (rawUrl) {
    const parsed = parseUserUrl(rawUrl);
    if (!parsed || parsed.href.length > URL_MAX)
      return setFormError('Please enter a valid URL or leave it empty.', urlInput);
    playerUrl = parsed.href;
  }
  setFormError('');

  const loadingIndicator = document.getElementById('loading-indicator');
  submitButton.style.display = 'none';
  loadingIndicator.style.display = 'block';

  try {
    // Track each board separately so a retry after a partial failure never double-posts.
    const jobs = [];
    if (qualifiesAllTime && !submittedBoards.alltime)
      jobs.push(
        addHighScore(playerName, totalScore, playerUrl).then(() => {
          submittedBoards.alltime = true;
        }),
      );
    if (qualifiesDaily && !submittedBoards.daily)
      jobs.push(
        addDailyHighScore(playerName, totalScore, playerUrl, dailyDay).then(() => {
          submittedBoards.daily = true;
        }),
      );
    const results = await Promise.allSettled(jobs);
    if (results.some((r) => r.status === 'rejected')) {
      console.error('Error adding high score:', results);
      setFormError("Couldn't submit your score. Check your connection and try again.");
      return;
    }
    localStorage.setItem('bpmguesser_last_name', playerName);
    localStorage.setItem('bpmguesser_last_url', rawUrl);
    mySubmittedScore = { name: playerName, score: totalScore };
    myRank = {
      alltime: submittedBoards.alltime ? pendingRanks.alltime : null,
      daily: submittedBoards.daily ? pendingRanks.daily : null,
    };
    showFinalScreen();
  } finally {
    submitButton.style.display = 'block';
    loadingIndicator.style.display = 'none';
  }
}

function rankStatusText(rank) {
  if (!rank) return '';
  const parts = [];
  if (rank.daily) parts.push(`#${rank.daily} today`);
  if (rank.alltime) parts.push(`#${rank.alltime} all time`);
  return parts.length ? `You placed ${parts.join(' · ')}` : '';
}

function showFinalScreen() {
  gameArea.style.display = 'none';
  showScreen('end-screen');
  endGameButton.style.display = 'none';

  const endContainer = document.getElementById('end-container');
  const endPanel = document.getElementById('end-scores-panel');
  if (endContainer) {
    endContainer.classList.remove('end-scores-open');
  }
  const endTgl = document.getElementById('end-toggle-scores');
  if (endTgl) {
    endTgl.classList.remove('is-active');
    endTgl.setAttribute('aria-pressed', 'false');
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    endTgl.classList.toggle('has-badge', !!(mySubmittedScore && mobile));
  }
  if (endPanel) {
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    endPanel.setAttribute('aria-hidden', mobile ? 'true' : 'false');
    resetHighScorePanelScroll(endPanel);
  }

  const overallGrade = getGameGrade(totalScore);
  document.getElementById('final-score').textContent = totalScore.toFixed(2);
  const gradeBadge = document.getElementById('final-grade-badge');
  if (gradeBadge) {
    gradeBadge.textContent = overallGrade;
    gradeBadge.className = `round-grade-badge grade-${overallGrade}`;
  }

  if (gameMode === 'daily') {
    saveDailyResult(totalScore, roundResults);
    updateDailyStatus();
  }

  if (!gameRecorded) {
    gameRecorded = true;
    recordGame({ mode: gameMode, day: dailyDay, score: totalScore, results: roundResults });
  }

  const playAgainBtn = document.getElementById('play-again');
  if (playAgainBtn)
    playAgainBtn.style.display = gameMode === 'daily' ? 'none' : 'flex';

  const pb = getPersonalBest();
  const pbStatus = document.getElementById('pb-status');
  const isNewPB = pb === null || totalScore > pb;
  if (isNewPB) setPersonalBest(totalScore);
  if (pbStatus) {
    if (isNewPB) {
      pbStatus.textContent = 'New personal best!';
      pbStatus.className = 'pb-status pb-new';
    } else {
      pbStatus.textContent = `Personal best: ${pb.toFixed(2)}`;
      pbStatus.className = 'pb-status';
    }
  }
  const rankStatus = document.getElementById('rank-status');
  if (rankStatus) {
    const text = rankStatusText(myRank);
    rankStatus.textContent = text;
    rankStatus.hidden = !text;
  }

  // Celebrate a beaten personal best (not the very first game) or an S-grade game.
  if ((isNewPB && pb !== null && totalScore > 0) || overallGrade === 'S') {
    setTimeout(() => celebrate({ originY: 0.45, count: 120 }), 200);
  }

  const roundResultsDiv = document.getElementById('round-results');
  if (roundResults.length > 0) {
    roundResultsDiv.innerHTML = roundResults
      .map((result) => {
        const grade = getGrade(result.score);
        const rid = `end-round-${result.round}`;
        return `<div class="round-result">
                <button type="button" class="round-result-top" aria-expanded="false" aria-controls="${rid}" aria-label="Show round details">
                    <div class="round-result-score-block">
                        <p class="round-result-label">Round ${result.round}</p>
                        <div class="round-result-score-row">
                            <span class="round-result-score">${result.score.toFixed(2)}</span>
                            <span class="round-grade-badge grade-${grade}">${grade}</span>
                        </div>
                    </div>
                    <i class="ph ph-caret-down round-result__caret" aria-hidden="true"></i>
                </button>
                <div class="result-details-wrap" aria-hidden="true">
                <div class="result-details" id="${rid}">
                    <div class="result-item">
                        <span class="result-label">Actual BPM</span>
                        <span class="result-value">${result.actualBPM}</span>
                    </div>
                    <div class="result-item">
                        <span class="result-label">Your Guess</span>
                        <span class="result-value">${result.guessedBPM || '—'}</span>
                    </div>
                    <div class="result-item">
                        <span class="result-label">Time</span>
                        <span class="result-value">${result.timeTaken.toFixed(2)}s</span>
                    </div>
                    <div class="result-item">
                        <span class="result-label">Speed Bonus</span>
                        <span class="result-value result-value--bonus">${result.speedBonus > 0 ? '+' + result.speedBonus.toFixed(2) : '—'}</span>
                    </div>
                </div>
                </div>
            </div>`;
      })
      .join('');
  } else {
    roundResultsDiv.innerHTML = '<p>No rounds played.</p>';
  }

  // Match leaderboard tab to the mode they just played
  switchEndScoreTab(gameMode === 'daily' ? 'today' : 'alltime');
  setupShareButton();
}

function setupShareButton() {
  const shareBtn = document.getElementById('share-score');
  if (!shareBtn) return;

  const idleHTML = prefersShareSheet()
    ? 'Share results <i class="ph-bold ph-export"></i>'
    : 'Copy results <i class="ph-bold ph-copy"></i>';
  shareBtn.innerHTML = idleHTML;

  shareBtn.onclick = async () => {
    const text = buildShareText({
      mode: gameMode,
      day: dailyDay,
      results: roundResults,
      total: totalScore,
    });
    const outcome = await shareText(text);
    if (outcome === 'copied') {
      shareBtn.innerHTML = 'Copied! <i class="ph-bold ph-check"></i>';
    } else if (outcome === 'failed') {
      shareBtn.textContent = 'Copy failed';
    } else {
      return;
    }
    setTimeout(() => {
      shareBtn.innerHTML = idleHTML;
    }, 2000);
  };
}

async function shareDailyResult(result) {
  const text = buildShareText({
    mode: 'daily',
    day: getDayNumber(),
    results: result.results || [],
    total: Number(result.score || 0),
  });
  const outcome = await shareText(text);
  if (outcome !== 'copied') return;
  const label = document.querySelector('#start-daily .home-daily-label');
  if (label) {
    const orig = label.textContent;
    label.textContent = 'Copied!';
    setTimeout(() => {
      label.textContent = orig;
    }, 1500);
  }
}

function toggleEndScores() {
  if (!isMobileScoresLayout()) {
    return;
  }
  const container = document.getElementById('end-container');
  const btn = document.getElementById('end-toggle-scores');
  const panel = document.getElementById('end-scores-panel');
  if (!container || !btn || !panel) return;
  const open = container.classList.contains('end-scores-open');
  if (open) {
    panel.classList.add('is-closing');
    beginScoresPanelAnimation(panel);
    container.classList.remove('end-scores-open');
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
    panel.setAttribute('aria-hidden', 'true');
    afterScoresPanelTransition(panel, () => {
      panel.classList.remove('is-closing');
      resetHighScorePanelScroll(panel);
    });
  } else {
    container.classList.add('end-scores-open');
    btn.classList.add('is-active');
    btn.classList.remove('has-badge');
    btn.setAttribute('aria-pressed', 'true');
    panel.setAttribute('aria-hidden', 'false');
    beginScoresPanelAnimation(panel);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => refreshHighScoreStickyPin(panel));
    });
  }
}

// ===== END SCREEN HIGH SCORES TABS =====
function switchEndScoreTab(tab) {
  const alltimeBtn = document.getElementById('tab-alltime-end');
  const todayBtn = document.getElementById('tab-today-end');
  if (!alltimeBtn || !todayBtn) return;
  alltimeBtn.classList.toggle('hs-tab--active', tab === 'alltime');
  todayBtn.classList.toggle('hs-tab--active', tab === 'today');
  alltimeBtn.setAttribute('aria-selected', String(tab === 'alltime'));
  todayBtn.setAttribute('aria-selected', String(tab === 'today'));
  void loadScoreList('high-scores-list-end', tab);
}

const _highScoreStickyPinByPanel = new WeakMap();

function refreshHighScoreStickyPin(panel) {
  _highScoreStickyPinByPanel.get(panel)?.();
}

function resetHighScorePanelScroll(panel) {
  if (!panel) return;
  panel.scrollTop = 0;
  refreshHighScoreStickyPin(panel);
}

/**
 * Sticky tab bar: `position: sticky` + `.is-pinned` when the title scrolls past the panel top.
 * Uses scroll/resize/ResizeObserver (not IntersectionObserver) so updates track layout reliably.
 */
function bindHighScoreStickyTabsForPanel(panel) {
  const titleBlock = panel.querySelector('.home-scores-header');
  const stickyBar = panel.querySelector('.hs-tabs-sticky');
  if (!titleBlock || !stickyBar) return;

  const updatePinned = () => {
    const pr = panel.getBoundingClientRect();
    const tr = titleBlock.getBoundingClientRect();
    const pinned = tr.bottom <= pr.top + 1;
    stickyBar.classList.toggle('is-pinned', pinned);
  };

  panel.addEventListener('scroll', updatePinned, { passive: true });
  window.addEventListener('resize', updatePinned, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      updatePinned();
    });
    ro.observe(panel);
    ro.observe(titleBlock);
    const inner = panel.querySelector('.home-scores-inner');
    if (inner) ro.observe(inner);
  }
  _highScoreStickyPinByPanel.set(panel, updatePinned);
  updatePinned();
}

function initHighScoreStickyTabs() {
  for (const id of ['home-scores-panel', 'end-scores-panel']) {
    const panel = document.getElementById(id);
    if (panel) bindHighScoreStickyTabsForPanel(panel);
  }
}

// ===== HOME HIGH SCORES PANEL =====
let homeScoresLoaded = false;
let activeScoreTab = 'alltime';
let _scoresPanelTimer1, _scoresPanelTimer2, _scoresPanelCloseReset = null;
const SCORES_PANEL_MS = 460;

function isMobileScoresLayout() {
  return window.matchMedia('(max-width: 800px)').matches;
}

function afterScoresPanelTransition(panel, callback) {
  if (!panel) {
    callback();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    panel.removeEventListener('transitionend', onEnd);
    clearTimeout(fallback);
    callback();
  };
  const onEnd = (event) => {
    if (event.target !== panel) return;
    if (event.propertyName !== 'max-width' && event.propertyName !== 'left') return;
    finish();
  };
  panel.addEventListener('transitionend', onEnd);
  const fallback = setTimeout(finish, SCORES_PANEL_MS);
}

function beginScoresPanelAnimation(panel) {
  if (!panel) return;
  panel.classList.add('is-animating');
  afterScoresPanelTransition(panel, () => {
    panel.classList.remove('is-animating');
  });
}

/** View currently shown in the home side panel ('scores' | 'stats' | 'about'), or null when closed. */
let activePanelView = null;
let panelViewSwitchTimer = null;

function panelViewEl(view) {
  return document.querySelector(`#home-scores-panel [data-panel-view="${view}"]`);
}

function setPanelToggleState(view) {
  document.querySelectorAll('[data-panel-toggle]').forEach((btn) => {
    const on = btn.dataset.panelToggle === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

/** Show one view, hide the others, and (re)build any dynamic content it needs. */
function showPanelView(view) {
  activePanelView = view;
  document
    .querySelectorAll('#home-scores-panel [data-panel-view]')
    .forEach((v) => (v.hidden = v.dataset.panelView !== view));
  setPanelToggleState(view);
  if (view === 'stats') {
    document.getElementById('stats-body').innerHTML = renderStatsHTML();
  }
}

/** Header (+ tabs) fade in, then the body/list staggers in — same choreography for every view. */
function revealPanelView(view, { headerDelay, bodyDelay, scoresAlreadyLoaded }) {
  const root = panelViewEl(view);
  if (!root) return;
  _scoresPanelTimer1 = setTimeout(() => {
    root.querySelector('.home-scores-header')?.classList.add('is-visible');
    root.querySelector('.hs-tabs-sticky')?.classList.add('is-visible');
    if (view !== 'scores') {
      _scoresPanelTimer2 = setTimeout(() => staggerPanelBody(root), bodyDelay);
    } else if (scoresAlreadyLoaded) {
      _scoresPanelTimer2 = setTimeout(() => staggerHomeScoreItems(), bodyDelay);
    }
  }, headerDelay);
}

function staggerPanelBody(root) {
  const blocks = root.querySelectorAll('.panel-body > *');
  requestAnimationFrame(() => {
    blocks.forEach((el, i) => {
      el.style.transitionDelay = `${i * 80}ms`;
      el.classList.add('is-visible');
    });
  });
}

/** Icon click: open on that view, close if it's already showing, or swap views in place. */
function openPanelView(view) {
  const isOpen = document
    .getElementById('home-wrapper')
    .classList.contains('scores-open');
  if (!isOpen) {
    toggleHomeScores({ view });
  } else if (activePanelView === view) {
    toggleHomeScores();
  } else {
    switchPanelView(view);
  }
}

/** Swap content without re-running the slide: quick exit, then the new view's stagger. */
function switchPanelView(view) {
  const panel = document.getElementById('home-scores-panel');
  clearTimeout(_scoresPanelTimer1);
  clearTimeout(_scoresPanelTimer2);
  clearTimeout(panelViewSwitchTimer);
  activePanelView = view; // so a second click on this icon during the swap closes the panel
  setPanelToggleState(view);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  panel.classList.add('is-closing'); // reuses the panel's exit styles (fade up + blur)
  panelViewSwitchTimer = setTimeout(
    () => {
      panel.classList.remove('is-closing');
      resetHomeScorePanel();
      showPanelView(view);
      panel.scrollTop = 0;
      if (view === 'scores' && !homeScoresLoaded) {
        void loadScoreList('home-scores-list', activeScoreTab);
        homeScoresLoaded = true;
        revealPanelView(view, { headerDelay: 0, bodyDelay: 0, scoresAlreadyLoaded: false });
      } else {
        revealPanelView(view, { headerDelay: 0, bodyDelay: 60, scoresAlreadyLoaded: true });
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => refreshHighScoreStickyPin(panel)),
      );
    },
    reduced ? 0 : 140,
  );
}

function toggleHomeScores({ instant = false, view = 'scores' } = {}) {
  const wrapper = document.getElementById('home-wrapper');
  const panel = document.getElementById('home-scores-panel');

  clearTimeout(_scoresPanelTimer1);
  clearTimeout(_scoresPanelTimer2);
  clearTimeout(panelViewSwitchTimer);
  if (_scoresPanelCloseReset) {
    clearTimeout(_scoresPanelCloseReset);
    _scoresPanelCloseReset = null;
  }

  const isCurrentlyOpen = wrapper.classList.contains('scores-open');

  if (isCurrentlyOpen) {
    panel.classList.add('is-closing');
    if (!instant) beginScoresPanelAnimation(panel);

    wrapper.classList.remove('scores-open');
    activePanelView = null;
    setPanelToggleState(null);
    panel.setAttribute('aria-hidden', 'true');

    let closed = false;
    const finishClose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(_scoresPanelCloseReset);
      _scoresPanelCloseReset = null;
      panel.classList.remove('is-closing');
      resetHomeScorePanel();
      resetHighScorePanelScroll(panel);
    };

    if (instant) {
      finishClose();
      return;
    }

    _scoresPanelCloseReset = setTimeout(finishClose, SCORES_PANEL_MS);
    afterScoresPanelTransition(panel, () => {
      clearTimeout(_scoresPanelCloseReset);
      finishClose();
    });
  } else {
    if (instant) wrapper.classList.add('scores-open--instant');

    panel.classList.remove('is-closing');
    showPanelView(view);
    wrapper.classList.add('scores-open');
    panel.setAttribute('aria-hidden', 'false');

    if (!instant) beginScoresPanelAnimation(panel);

    let scoresAlreadyLoaded = true;
    if (view === 'scores' && !homeScoresLoaded) {
      scoresAlreadyLoaded = false;
      void loadScoreList('home-scores-list', activeScoreTab); // staggers internally after render
      homeScoresLoaded = true;
    }

    const isMobileHome = isMobileScoresLayout();
    revealPanelView(view, {
      headerDelay: instant ? 0 : isMobileHome ? 80 : 260,
      bodyDelay: instant ? 0 : isMobileHome ? 90 : 160,
      scoresAlreadyLoaded,
    });

    if (instant) {
      requestAnimationFrame(() => {
        wrapper.classList.remove('scores-open--instant');
      });
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => refreshHighScoreStickyPin(panel));
    });
  }
}

function staggerScoreItems(listId) {
  const items = document.querySelectorAll(`#${listId} .home-score-entry`);
  requestAnimationFrame(() => {
    items.forEach((el, i) => {
      el.style.transitionDelay = `${i * 40}ms`;
      el.classList.add('is-visible');
    });
  });
}

function scrollMineIntoView(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const mine = list.querySelector('.is-mine');
  if (!mine) return;
  const items = list.querySelectorAll('.home-score-entry');
  const idx = Array.from(items).indexOf(mine);
  // Wait for the stagger to reveal this specific row before scrolling
  const delay = idx * 40 + 220;
  setTimeout(() => mine.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), delay);
}

function staggerHomeScoreItems() {
  staggerScoreItems('home-scores-list');
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      refreshHighScoreStickyPin(document.getElementById('home-scores-panel')),
    ),
  );
}

/** Instantly return every panel view to its pre-reveal state (headers, tabs, rows, body blocks). */
function resetHomeScorePanel() {
  const els = document.querySelectorAll(
    '#home-scores-panel .home-scores-header, #home-scores-panel .hs-tabs-sticky, #home-scores-list .home-score-entry, #home-scores-panel .panel-body > *',
  );
  // Disable transitions so reset is instant (no visible flash before panel collapses)
  els.forEach((el) => {
    el.style.transition = 'none';
    el.style.transitionDelay = '';
    el.classList.remove('is-visible', 'is-pinned');
  });
  // Re-enable transitions after the reset has been painted
  requestAnimationFrame(() => {
    els.forEach((el) => {
      el.style.transition = '';
    });
  });
}

function switchScoreTab(tab) {
  activeScoreTab = tab;
  const alltimeBtn = document.getElementById('tab-alltime');
  const todayBtn = document.getElementById('tab-today');
  alltimeBtn.classList.toggle('hs-tab--active', tab === 'alltime');
  todayBtn.classList.toggle('hs-tab--active', tab === 'today');
  alltimeBtn.setAttribute('aria-selected', String(tab === 'alltime'));
  todayBtn.setAttribute('aria-selected', String(tab === 'today'));
  void loadScoreList('home-scores-list', tab);
}

// ===== LEADERBOARD LISTS (shared by home + end panels) =====
/** Per-list request counter so a slow fetch can't overwrite a newer tab selection. */
const listRequestIds = new Map();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setListMessage(list, text, className) {
  list.replaceChildren(el('li', className, text));
}

/** Builds rows with DOM APIs only — names/URLs come from other players and are never parsed as HTML. */
function renderScoreList(list, entries) {
  if (!entries.length) {
    setListMessage(list, 'No scores yet — be the first!', 'home-score-empty');
    return;
  }
  const frag = document.createDocumentFragment();
  entries.forEach((entry, i) => {
    const isMe =
      !!mySubmittedScore &&
      entry.name === mySubmittedScore.name &&
      entry.score.toFixed(2) === mySubmittedScore.score.toFixed(2);

    const li = el('li', `home-score-entry${isMe ? ' is-mine' : ''}`);
    const left = el('div', 'home-score-left');
    left.append(el('span', 'home-score-rank', `${i + 1}.`));

    const nameObj = el('div', 'home-score-name-obj');
    nameObj.append(el('span', 'home-score-name', entry.name));
    const url = parseUserUrl(entry.url);
    if (url) {
      const a = el('a', 'home-score-url', url.hostname);
      a.href = url.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow ugc';
      nameObj.append(a);
    }
    left.append(nameObj);
    if (isMe) left.append(el('span', 'home-score-you', 'You'));

    li.append(left, el('span', 'home-score-value', entry.score.toFixed(2)));
    frag.append(li);
  });
  list.replaceChildren(frag);
}

async function loadScoreList(listId, tab) {
  const list = document.getElementById(listId);
  if (!list) return;
  const requestId = (listRequestIds.get(listId) || 0) + 1;
  listRequestIds.set(listId, requestId);
  setListMessage(list, 'Loading…', 'home-score-loading');

  try {
    const entries =
      tab === 'today'
        ? await getDailyHighScores(dailyDay ?? getDayNumber())
        : await getHighScores();
    if (listRequestIds.get(listId) !== requestId) return;
    renderScoreList(list, entries);
    if (listId === 'home-scores-list') staggerHomeScoreItems();
    else staggerScoreItems(listId);
    scrollMineIntoView(listId);
  } catch (error) {
    if (listRequestIds.get(listId) !== requestId) return;
    setListMessage(list, 'Could not load scores.', 'home-score-empty');
    console.error(`Error fetching ${tab} scores:`, error);
  }
}

function triggerAnim(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function animateCount(node, target, duration = 600) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    node.textContent = (target * eased).toFixed(2);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function resetGame({ immediate = false } = {}) {
  resetRunState();
  isCountdownActive = false;
  gameMode = 'quick';
  dailyBPMs = [];
  dailyDate = null;
  dailyDay = null;

  // Reset scores panel so it re-fetches fresh data next open
  homeScoresLoaded = false;
  clearTimeout(_scoresPanelTimer1);
  clearTimeout(_scoresPanelTimer2);
  if (_scoresPanelCloseReset) {
    clearTimeout(_scoresPanelCloseReset);
    _scoresPanelCloseReset = null;
  }
  const wrapper = document.getElementById('home-wrapper');
  if (wrapper && wrapper.classList.contains('scores-open')) {
    toggleHomeScores({ instant: true });
  }

  const endC = document.getElementById('end-container');
  if (endC?.classList.contains('end-scores-open')) {
    endC.classList.remove('end-scores-open');
    document.getElementById('end-toggle-scores')?.classList.remove('is-active');
    document
      .getElementById('end-toggle-scores')
      ?.setAttribute('aria-pressed', 'false');
    const ep = document.getElementById('end-scores-panel');
    ep?.setAttribute('aria-hidden', 'true');
    resetHighScorePanelScroll(ep);
  }

  endGameButton.style.display = 'none';
  submitGuessButton.disabled = false;
  changeBackgroundColor(false);
  clearInterval(timerInterval);
  clearInterval(intermissionInterval);
  stopMetronome();
  clearInterval(countInterval);

  const goHome = () => {
    gameArea.style.display = 'none';
    showScreen('home-screen');
    updateDailyStatus();
    if (!isMobileScoresLayout()) toggleHomeScores({ instant: true });
  };

  if (immediate) {
    goHome();
    return;
  }
  endScreen.style.opacity = 0;
  setTimeout(goHome, 500);
}
