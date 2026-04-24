// main.js
import {
  getHighScores,
  addHighScore,
  getDailyHighScores,
  addDailyHighScore,
  LEADERBOARD_TOP_N,
  initFirebaseAnalytics,
} from './firebase.js';
import {
  calculateScore,
  calculateScoreBreakdown,
  generateRandomBPM,
  TIME_PENALTY_THRESHOLD,
  TOTAL_ROUNDS,
  BPM_RANGES,
  getGrade,
  getDayNumber,
  generateDailyBPMs,
} from './gameLogic.js';
import {
  initAudio,
  getAudioContext,
  playMetronomeSound,
  updateVisualMetronome,
  changeBackgroundColor,
} from './audioVisual.js';

// No client-side profanity filter — enforce via Firestore security rules or a server-side function.
function containsBadWords(_text) {
  return false;
}

let actualBPM,
  startTime,
  timerInterval,
  schedulerTimeout,
  countInterval,
  intermissionInterval;
let nextBeatTime = 0;
let gameMode = 'quick'; // 'quick' | 'daily'
let dailyBPMs = [];
let qualifiesAllTime = false;
let qualifiesDaily = false;
let mySubmittedScore = null; // { name, score } set after a successful high score submission

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

function showModal(html) {
  const modal = document.getElementById('app-modal');
  document.getElementById('app-modal-body').innerHTML = html;
  modal.style.display = 'flex';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => modal.classList.add('is-open')),
  );
}

function closeModal() {
  const modal = document.getElementById('app-modal');
  modal.classList.remove('is-open');
  modal.addEventListener(
    'transitionend',
    () => {
      if (!modal.classList.contains('is-open')) modal.style.display = 'none';
    },
    { once: true },
  );
}

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

function getScoringHTML() {
  return `
        <h3 class="hero-title" id="app-modal-title"><i class="ph ph-circle"></i> BPM Guesser</h3>
        <p>Listen to the metronome and guess the BPM. Each round is scored on two things:</p>
        <p><strong>Accuracy</strong> — Up to 100 points. The closer your guess, the higher your score. A guess more than 20 BPM away scores zero for that round.</p>
        <p><strong>Speed bonus</strong> — Up to +33 points. The faster you commit to your guess, the more bonus you earn. The bonus decays to zero at 10 seconds, so quick decisions pay off.</p>
        <p>If you take longer than 3 seconds, you'll lose 0.5 points per second after that. The maximum score per round is 133, and 399 across all three rounds.</p>
        <h4><i class="ph ph-dot"></i> Game Modes</h4>
        <p><strong>Daily Challenge</strong> — The same three rounds for everyone, chosen from today's date. You get one run per day and your total is saved for the day's leaderboard.</p>
        <p><strong>Quick Play</strong> — A new random set every time, with no daily limit. Use it to practice; only Daily Challenge results appear on the "Today's game" board.</p>
        <p>This game was conceived and developed by <a href="https://robysaavedra.com" target="_blank">Roby Saavedra</a>.</p>
    `;
}

function getModeInfoHTML() {
  return `
        <h3 class="hero-title" id="app-modal-title">Game Modes</h3>
        <p><strong>Daily Challenge</strong> — The same three rounds for everyone, chosen from today's date. You get one run per day and your total is saved for the day's leaderboard.</p>
        <p><strong>Quick Play</strong> — A new random set every time, with no daily limit. Use it to practice; only Daily Challenge results appear on the "Today's game" board.</p>
    `;
}

function getPersonalBest() {
  const val = localStorage.getItem('bpmguesser_pb');
  return val !== null ? parseFloat(val) : null;
}

function setPersonalBest(score) {
  localStorage.setItem('bpmguesser_pb', score.toString());
}

function getDailyKey() {
  const n = new Date();
  return `bpmguesser_daily_${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
}

function getDailyResult() {
  const stored = localStorage.getItem(getDailyKey());
  return stored ? JSON.parse(stored) : null;
}

function saveDailyResult(score, results) {
  localStorage.setItem(getDailyKey(), JSON.stringify({ score, results }));
}

function updateDailyStatus() {
  const result = getDailyResult();
  const dailyBtn = document.getElementById('start-daily');
  const eyebrowSep = document.getElementById('daily-eyebrow-sep');
  const eyebrowThanks = document.getElementById('daily-eyebrow-thanks');
  if (!dailyBtn) return;

  if (result) {
    dailyBtn.classList.add('is-played');
    dailyBtn.innerHTML = `
            <span class="home-daily-label">Daily Challenge</span>
            <span class="home-daily-score-container">
                <span class="home-daily-score-details">
                    <span class="home-daily-score-label">Your score</span>
                    <span class="home-daily-score-value">${result.score.toFixed(2)}</span>
                </span>
                <i class="ph-bold ph-check home-daily-check"></i>
                <i class="ph-bold ph-copy home-daily-copy"></i>
            </span>
        `;
    if (eyebrowSep) eyebrowSep.textContent = '·';
    if (eyebrowThanks) eyebrowThanks.textContent = 'Thanks for playing!';
  } else {
    dailyBtn.classList.remove('is-played');
    dailyBtn.innerHTML = `
            <span class="home-daily-label">Daily Challenge</span>
            <i class="ph-bold ph-arrow-right"></i>
        `;
    if (eyebrowSep) eyebrowSep.textContent = '';
    if (eyebrowThanks) eyebrowThanks.textContent = '';
  }
}

function updateHomePB() {
  const pb = getPersonalBest();
  const el = document.getElementById('pb-home');
  if (el) el.textContent = pb !== null ? `Personal best: ${pb.toFixed(2)}` : '';
}

// ── Theme ───────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const iconLight = document.getElementById('theme-icon-light');
  const iconDark = document.getElementById('theme-icon-dark');
  if (iconLight) iconLight.style.display = dark ? 'none' : '';
  if (iconDark) iconDark.style.display = dark ? '' : 'none';
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
  const dayNumberEl = document.getElementById('day-number');
  if (dayNumberEl) dayNumberEl.textContent = `#${getDayNumber()}`;
  updateDailyStatus();
  initCookieBanner();
  showScreen('home-screen', { focusHeading: false });

  const isSafari =
    /Safari/i.test(navigator.userAgent) &&
    !/Chrome|CriOS|FxiOS/i.test(navigator.userAgent);
  const needsGesture =
    isSafari || /iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (needsGesture) {
    const audioPermissionModal = document.getElementById(
      'audio-permission-modal',
    );
    audioPermissionModal.style.display = 'flex';
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        audioPermissionModal.classList.add('is-open'),
      ),
    );
    document.getElementById('enable-audio').addEventListener('click', () => {
      initAudio();
      audioPermissionModal.classList.remove('is-open');
      const afterClose = () => {
        if (!audioPermissionModal.classList.contains('is-open')) {
          audioPermissionModal.style.display = 'none';
        }
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        requestAnimationFrame(afterClose);
      } else {
        audioPermissionModal.addEventListener('transitionend', afterClose, {
          once: true,
        });
      }
    });
  } else {
    initAudio();
  }

  document.getElementById('start-daily').addEventListener('click', () => {
    const existingResult = getDailyResult();
    if (existingResult) {
      copyDailyResult(existingResult);
      return;
    }
    gameMode = 'daily';
    dailyBPMs = generateDailyBPMs();
    showScreen('countdown-screen');
    startGameCountdown();
  });

  document.getElementById('start-game').addEventListener('click', () => {
    gameMode = 'quick';
    showScreen('countdown-screen');
    startGameCountdown();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.getElementById('app-modal').style.display === 'flex') {
        closeModal();
      } else {
        endGame();
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
  document
    .getElementById('continue-to-final')
    .addEventListener('click', showFinalScreen);
  document.getElementById('skip-high-score').addEventListener('click', () => {
    document.getElementById('skip-high-score').disabled = true;
    showFinalScreen();
  });
  document.getElementById('play-again').addEventListener('click', resetGame);
  document.getElementById('go-home').addEventListener('click', resetGame);
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

  document.getElementById('open-about').addEventListener('click', () => {
    showModal(getScoringHTML());
  });

  document
    .getElementById('toggle-scores')
    .addEventListener('click', toggleHomeScores);
  document
    .getElementById('close-scores')
    .addEventListener('click', toggleHomeScores);

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

  document
    .getElementById('app-modal-confirm')
    .addEventListener('click', closeModal);

  document.getElementById('app-modal').addEventListener('click', (event) => {
    if (event.target === document.getElementById('app-modal')) closeModal();
  });

  initHighScoreStickyTabs();

  // Open scores panel by default on desktop
  if (!window.matchMedia('(max-width: 800px)').matches) {
    toggleHomeScores();
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

function startGameCountdown() {
  endGameButton.style.display = 'block';
  // Ensure home scores panel is closed before game starts
  const wrapper = document.getElementById('home-wrapper');
  if (wrapper && wrapper.classList.contains('scores-open')) {
    clearTimeout(_scoresPanelCloseReset);
    _scoresPanelCloseReset = undefined;
    resetHomeScorePanel();
    wrapper.style.transition = '';
    const hsPanel = document.getElementById('home-scores-panel');
    if (hsPanel) hsPanel.style.background = '';
    wrapper.classList.remove('scores-open');
    document.getElementById('toggle-scores')?.classList.remove('is-active');
    hsPanel?.setAttribute('aria-hidden', 'true');
    resetHighScorePanelScroll(hsPanel);
  }
  changeBackgroundColor(true);
  let count = 3;
  countdownArea.textContent = 'Get ready...';
  isCountdownActive = true;

  countInterval = setInterval(() => {
    if (count > 0) {
      countdownArea.textContent = count;
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
        `#${getDayNumber()}`;
      dailyIndicator.style.display = '';
    } else {
      dailyIndicator.style.display = 'none';
    }
  }

  setTimeout(() => {
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

    setTimeout(() => {
      bpmGuessInput.focus();
      bpmGuessInput.select();
    }, 500);

    startMetronome();
  }, 300);
}

function startMetronome() {
  const audioCtx = getAudioContext();
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
    setTimeout(() => updateVisualMetronome(circle1), visualDelay);

    nextBeatTime += secondsPerBeat;
    currentBeat++;
  }

  schedulerTimeout = setTimeout(schedulerTick, SCHEDULE_INTERVAL);
}

function stopMetronome() {
  clearTimeout(schedulerTimeout);
  schedulerTimeout = null;
  resetCircles();
}

function resetCircles() {
  circle1.classList.remove('beat-pulse');
}

function submitGuess() {
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

  const runningScoreEl = document.getElementById('running-score');
  const runningScoreValue = document.getElementById('running-score-value');
  if (runningScoreEl && runningScoreValue) {
    runningScoreValue.textContent = totalScore.toFixed(2);
    runningScoreEl.style.display = 'block';
  }

  showIntermission();
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
        </div>
        <div class="intermission-separator"></div>
        ${nextSection}
    `;

  const scoreEl = document.getElementById('intermission-score-value');
  if (scoreEl) animateCount(scoreEl, lastResult.score);

  if (speedBonus > 0) {
    setTimeout(() => {
      document.getElementById('intermission-bonus')?.classList.add('is-visible');
    }, 350);
  }

  intermissionInterval = setInterval(() => {
    count--;
    const countdownEl = document.querySelector('.intermission-countdown');
    if (count > 0) {
      if (countdownEl) countdownEl.textContent = count;
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
  stopMetronome();
  clearInterval(timerInterval);
  clearInterval(intermissionInterval);

  if (isCountdownActive) {
    clearInterval(countInterval);
    isCountdownActive = false;
  }

  if (roundResults.length === 0) {
    roundResults.push({
      round: 1,
      actualBPM: 0,
      guessedBPM: 0,
      score: 0,
      timeTaken: 0,
    });
  }

  showFinalResults();
  endGameButton.style.display = 'none';
  changeBackgroundColor(false);
}

function showFinalResults() {
  endGameButton.style.display = 'none';
  document.getElementById('final-score-check').textContent =
    totalScore.toFixed(2);
  checkAndHandleHighScore();
}

async function checkAndHandleHighScore() {
  try {
    // Check all-time leaderboard
    const alltimeSnapshot = await getHighScores();
    qualifiesAllTime = alltimeSnapshot.size < LEADERBOARD_TOP_N;
    if (!qualifiesAllTime) {
      const lowest =
        alltimeSnapshot.docs[alltimeSnapshot.size - 1].data().score;
      qualifiesAllTime = totalScore > lowest;
    }

    // Check daily leaderboard (only for daily mode)
    qualifiesDaily = false;
    if (gameMode === 'daily') {
      const dayNum = getDayNumber();
      const dailySnapshot = await getDailyHighScores(dayNum);
      qualifiesDaily = dailySnapshot.size < LEADERBOARD_TOP_N;
      if (!qualifiesDaily) {
        const lowestDaily =
          dailySnapshot.docs[dailySnapshot.size - 1].data().score;
        qualifiesDaily = totalScore > lowestDaily;
      }
    }

    showScreen('high-score-check');

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
      document.getElementById('player-name-check').value = '';
      document.getElementById('player-url-check').value = '';
    } else {
      document.getElementById('high-score-input-area').style.display = 'none';
      document.getElementById('no-high-score-area').style.display = 'flex';
    }
  } catch (error) {
    console.error('Error checking high score:', error);
    showFinalScreen();
  }
}

async function submitHighScoreCheck() {
  const playerName = document.getElementById('player-name-check').value;
  let playerUrl = document.getElementById('player-url-check').value.trim();

  if (!playerName) {
    alert('Please enter your name.');
    return;
  }

  if (containsBadWords(playerName)) {
    alert('Please use appropriate language for your name.');
    return;
  }

  if (playerUrl) {
    playerUrl = prependHttps(playerUrl);
    if (!isValidUrl(playerUrl)) {
      alert('Please enter a valid URL or leave the field empty.');
      return;
    }
    if (await isUrlBlacklisted(playerUrl)) {
      alert('This URL is not allowed.');
      return;
    }
  }

  const submitButton = document.getElementById('submit-score-check');
  const loadingIndicator = document.getElementById('loading-indicator');
  submitButton.style.display = 'none';
  loadingIndicator.style.display = 'block';

  try {
    const submissions = [];
    if (qualifiesAllTime)
      submissions.push(addHighScore(playerName, totalScore, playerUrl));
    if (qualifiesDaily)
      submissions.push(
        addDailyHighScore(playerName, totalScore, playerUrl, getDayNumber()),
      );
    await Promise.all(submissions);
    mySubmittedScore = { name: playerName, score: totalScore };
  } catch (error) {
    console.error('Error adding high score:', error);
  } finally {
    submitButton.style.display = 'block';
    loadingIndicator.style.display = 'none';
    showFinalScreen();
  }
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

  const overallGrade = getGrade(totalScore);
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

  const playAgainBtn = document.getElementById('play-again');
  if (playAgainBtn)
    playAgainBtn.style.display = gameMode === 'daily' ? 'none' : 'flex';

  const pb = getPersonalBest();
  const pbStatus = document.getElementById('pb-status');
  if (pbStatus) {
    if (pb === null || totalScore > pb) {
      setPersonalBest(totalScore);
      updateHomePB();
      pbStatus.textContent = 'New personal best!';
      pbStatus.className = 'pb-status pb-new';
    } else {
      pbStatus.textContent = `Personal best: ${pb.toFixed(2)}`;
      pbStatus.className = 'pb-status';
    }
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
                        <span class="result-value">${result.guessedBPM}</span>
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

  shareBtn.onclick = async () => {
    const gradeEmoji = { S: '🎯', A: '🔥', B: '👍', C: '😅', F: '😬' };
    const roundLines = roundResults
      .map((r) => {
        const diff = Math.abs(r.actualBPM - r.guessedBPM);
        const grade = getGrade(r.score);
        return `${gradeEmoji[grade]} Round ${r.round}: ${r.score.toFixed(0)} pts (off by ${diff} BPM)`;
      })
      .join('\n');

    const header =
      gameMode === 'daily'
        ? `🎵 BPM Guesser Daily #${getDayNumber()}`
        : `🎵 BPM Guesser`;
    const text = `${header}\n${roundLines}\nTotal: ${totalScore.toFixed(2)} / ${TOTAL_ROUNDS * 100}\nbpmga.me`;

    try {
      await navigator.clipboard.writeText(text);
      shareBtn.innerHTML = 'Copied! <i class="ph-bold ph-check"></i>';
      setTimeout(() => {
        shareBtn.innerHTML = 'Copy results <i class="ph-bold ph-copy"></i>';
      }, 2000);
    } catch {
      shareBtn.textContent = 'Copy failed';
    }
  };
}

function toggleEndScores() {
  if (!window.matchMedia('(max-width: 800px)').matches) {
    return;
  }
  const container = document.getElementById('end-container');
  const btn = document.getElementById('end-toggle-scores');
  const panel = document.getElementById('end-scores-panel');
  if (!container || !btn || !panel) return;
  const open = container.classList.contains('end-scores-open');
  if (open) {
    container.classList.remove('end-scores-open');
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
    panel.setAttribute('aria-hidden', 'true');
    resetHighScorePanelScroll(panel);
  } else {
    container.classList.add('end-scores-open');
    btn.classList.add('is-active');
    btn.classList.remove('has-badge');
    btn.setAttribute('aria-pressed', 'true');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => refreshHighScoreStickyPin(panel));
    });
  }
}

// ===== END SCREEN HIGH SCORES TABS =====
let activeEndScoreTab = 'alltime';
/** Bumps on each end-screen tab change so slow async list fetches cannot overwrite a newer selection. */
let _endListRequestId = 0;

function switchEndScoreTab(tab) {
  const requestId = ++_endListRequestId;
  activeEndScoreTab = tab;
  const alltimeBtn = document.getElementById('tab-alltime-end');
  const todayBtn = document.getElementById('tab-today-end');
  if (!alltimeBtn || !todayBtn) return;
  alltimeBtn.classList.toggle('hs-tab--active', tab === 'alltime');
  todayBtn.classList.toggle('hs-tab--active', tab === 'today');
  alltimeBtn.setAttribute('aria-selected', String(tab === 'alltime'));
  todayBtn.setAttribute('aria-selected', String(tab === 'today'));
  if (tab === 'alltime') {
    void fetchAndDisplayHighScores('high-scores-list-end', requestId);
  } else {
    void renderTodaysScore('high-scores-list-end', requestId);
  }
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
let _scoresPanelTimer1, _scoresPanelTimer2, _scoresPanelCloseReset;

function toggleHomeScores() {
  const wrapper = document.getElementById('home-wrapper');
  const btn = document.getElementById('toggle-scores');
  const panel = document.getElementById('home-scores-panel');

  clearTimeout(_scoresPanelTimer1);
  clearTimeout(_scoresPanelTimer2);
  clearTimeout(_scoresPanelCloseReset);

  const isCurrentlyOpen = wrapper.classList.contains('scores-open');

  if (isCurrentlyOpen) {
    // Suppress the background color wave on close — snap bg instantly, only animate padding-left
    wrapper.style.transition = 'padding-left 0.4s cubic-bezier(0.2, 0, 0, 1)';
    panel.style.background = 'transparent';
    void wrapper.offsetWidth; // force reflow so snap takes effect before class removal

    wrapper.classList.remove('scores-open');
    btn.classList.remove('is-active');
    btn.setAttribute('aria-pressed', 'false');
    panel.setAttribute('aria-hidden', 'true');

    // Defer reset until the sheet finishes (mobile: slide 0.35s; desktop: flex 0.4s). If we
    // reset immediately, header/list snap invisible while only the back row still moves with the
    // panel, which reads as a mismatched unmount.
    _scoresPanelCloseReset = setTimeout(() => {
      _scoresPanelCloseReset = undefined;
      resetHomeScorePanel();
      resetHighScorePanelScroll(panel);
      wrapper.style.transition = '';
      panel.style.background = '';
    }, 420);
  } else {
    wrapper.classList.add('scores-open');
    btn.classList.add('is-active');
    btn.setAttribute('aria-pressed', 'true');
    panel.setAttribute('aria-hidden', 'false');

    const alreadyLoaded = homeScoresLoaded;
    if (!homeScoresLoaded) {
      fetchAndRenderHomeScores(); // calls staggerHomeScoreItems internally after render
      homeScoresLoaded = true;
    }
    // Desktop: delay until card slide animation finishes. Mobile: short delay (full-screen drill).
    const isMobileHome = window.matchMedia('(max-width: 767px)').matches;
    const headerRevealMs = isMobileHome ? 60 : 320;
    const staggerDelayMs = isMobileHome ? 100 : 180;
    _scoresPanelTimer1 = setTimeout(() => {
      const header = document.querySelector(
        '#home-scores-panel .home-scores-header',
      );
      const tabBar = document.querySelector(
        '#home-scores-panel .hs-tabs-sticky',
      );
      if (header) header.classList.add('is-visible');
      if (tabBar) tabBar.classList.add('is-visible');
      if (alreadyLoaded) {
        _scoresPanelTimer2 = setTimeout(
          () => staggerHomeScoreItems(),
          staggerDelayMs,
        );
      }
    }, headerRevealMs);

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

function resetHomeScorePanel() {
  const header = document.querySelector(
    '#home-scores-panel .home-scores-header',
  );
  const tabBar = document.querySelector('#home-scores-panel .hs-tabs-sticky');
  const items = document.querySelectorAll(
    '#home-scores-list .home-score-entry',
  );
  // Disable transitions so reset is instant (no visible flash before panel collapses)
  if (header) {
    header.style.transition = 'none';
    header.classList.remove('is-visible');
  }
  if (tabBar) {
    tabBar.style.transition = 'none';
    tabBar.classList.remove('is-visible');
    tabBar.classList.remove('is-pinned');
  }
  items.forEach((el) => {
    el.style.transition = 'none';
    el.style.transitionDelay = '';
    el.classList.remove('is-visible');
  });
  // Re-enable transitions after the reset has been painted
  requestAnimationFrame(() => {
    if (header) header.style.transition = '';
    if (tabBar) tabBar.style.transition = '';
    items.forEach((el) => {
      el.style.transition = '';
    });
  });
}

function switchScoreTab(tab) {
  activeScoreTab = tab;
  document
    .getElementById('tab-alltime')
    .classList.toggle('hs-tab--active', tab === 'alltime');
  document
    .getElementById('tab-today')
    .classList.toggle('hs-tab--active', tab === 'today');
  document
    .getElementById('tab-alltime')
    .setAttribute('aria-selected', String(tab === 'alltime'));
  document
    .getElementById('tab-today')
    .setAttribute('aria-selected', String(tab === 'today'));

  if (tab === 'alltime') {
    fetchAndRenderHomeScores();
  } else {
    renderTodaysScore();
  }
}

async function fetchAndRenderHomeScores() {
  const list = document.getElementById('home-scores-list');
  if (!list) return;
  list.innerHTML = '<li class="home-score-loading">Loading…</li>';

  try {
    const querySnapshot = await getHighScores();
    list.innerHTML = '';

    if (querySnapshot.empty) {
      list.innerHTML =
        '<li class="home-score-empty">No scores yet — be the first!</li>';
      return;
    }

    querySnapshot.docs.forEach((doc, i) => {
      const data = doc.data();
      const li = document.createElement('li');
      li.className = 'home-score-entry';

      let urlHTML = '';
      if (data.url && data.url.trim()) {
        const urlStr = prependHttps(data.url.trim());
        if (isValidUrl(urlStr)) {
          const hostname = new URL(urlStr).hostname;
          urlHTML = `<a class="home-score-url" href="${urlStr}" target="_blank" rel="noopener">${hostname}</a>`;
        }
      }

      li.innerHTML = `
                <div class="home-score-left">
                    <span class="home-score-rank">${i + 1}.</span>
                    <div class="home-score-name-obj">
                        <span class="home-score-name">${data.name}</span>
                        ${urlHTML}
                    </div>
                </div>
                <span class="home-score-value">${data.score.toFixed(2)}</span>
            `;
      list.appendChild(li);
    });
    staggerHomeScoreItems();
  } catch (e) {
    console.error('Error fetching home scores:', e);
    list.innerHTML = '<li class="home-score-empty">Could not load scores.</li>';
  }
}

async function renderTodaysScore(
  elementId = 'home-scores-list',
  listRequestId = null,
) {
  const list = document.getElementById(elementId);
  if (!list) return;
  list.innerHTML = '<li class="home-score-loading">Loading…</li>';

  try {
    const snapshot = await getDailyHighScores(getDayNumber());
    if (listRequestId != null && listRequestId !== _endListRequestId) {
      return;
    }
    list.innerHTML = '';

    if (snapshot.empty) {
      list.innerHTML =
        '<li class="home-score-empty">No scores yet — be the first!</li>';
      if (elementId === 'home-scores-list') staggerHomeScoreItems();
      return; // empty state has no entries to stagger
    }

    snapshot.docs.forEach((doc, i) => {
      const data = doc.data();
      const isMe = mySubmittedScore &&
        data.name === mySubmittedScore.name &&
        data.score.toFixed(2) === mySubmittedScore.score.toFixed(2);
      const li = document.createElement('li');
      li.className = 'home-score-entry' + (isMe ? ' is-mine' : '');
      let urlHTML = '';
      if (data.url && data.url.trim()) {
        const urlStr = prependHttps(data.url.trim());
        if (isValidUrl(urlStr)) {
          const hostname = new URL(urlStr).hostname;
          urlHTML = `<a class="home-score-url" href="${urlStr}" target="_blank" rel="noopener">${hostname}</a>`;
        }
      }
      const youPill = isMe ? '<span class="home-score-you">You</span>' : '';
      li.innerHTML = `
                <div class="home-score-left">
                    <span class="home-score-rank">${i + 1}.</span>
                    <div class="home-score-name-obj">
                        <span class="home-score-name">${data.name}</span>
                        ${urlHTML}
                    </div>
                    ${youPill}
                </div>
                <span class="home-score-value">${data.score.toFixed(2)}</span>
            `;
      list.appendChild(li);
    });

    if (elementId === 'home-scores-list') {
      staggerHomeScoreItems();
    } else {
      staggerScoreItems(elementId);
    }
    scrollMineIntoView(elementId);
  } catch (error) {
    if (listRequestId != null && listRequestId !== _endListRequestId) {
      return;
    }
    list.innerHTML = '<li class="home-score-empty">Could not load scores.</li>';
    console.error('Error fetching daily scores:', error);
  }
}

async function copyDailyResult(result) {
  const gradeEmoji = { S: '🎯', A: '🔥', B: '👍', C: '😅', F: '😬' };
  const roundLines = (result.results || [])
    .map((r, i) => {
      const diff = Math.abs(r.actualBPM - r.guessedBPM);
      const grade = getGrade(r.score);
      return `${gradeEmoji[grade]} Round ${i + 1}: ${r.score.toFixed(0)} pts (off by ${diff} BPM)`;
    })
    .join('\n');
  const text = `🎵 BPM Guesser Daily #${getDayNumber()}\n${roundLines}\nTotal: ${result.score.toFixed(2)} / ${TOTAL_ROUNDS * 100}\nbpmga.me`;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('start-daily');
    const label = btn && btn.querySelector('.home-daily-label');
    if (label) {
      const orig = label.textContent;
      label.textContent = 'Copied!';
      setTimeout(() => {
        label.textContent = orig;
      }, 1500);
    }
  } catch (e) {
    console.error('Copy failed', e);
  }
}

function animateCount(el, target, duration = 600) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = (target * eased).toFixed(2);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function resetGame() {
  currentRound = 1;
  totalScore = 0;
  roundResults = [];
  isCountdownActive = false;
  gameMode = 'quick';
  dailyBPMs = [];
  qualifiesAllTime = false;
  qualifiesDaily = false;
  mySubmittedScore = null;

  // Reset scores panel so it re-fetches fresh data next open
  homeScoresLoaded = false;
  clearTimeout(_scoresPanelTimer1);
  clearTimeout(_scoresPanelTimer2);
  clearTimeout(_scoresPanelCloseReset);
  const wrapper = document.getElementById('home-wrapper');
  if (wrapper && wrapper.classList.contains('scores-open')) {
    resetHomeScorePanel();
    const hp = document.getElementById('home-scores-panel');
    resetHighScorePanelScroll(hp);
    wrapper.classList.remove('scores-open');
    document.getElementById('toggle-scores')?.classList.remove('is-active');
    hp?.setAttribute('aria-hidden', 'true');
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
  stopMetronome();
  clearInterval(countInterval);

  endScreen.style.opacity = 0;
  setTimeout(() => {
    gameArea.style.display = 'none';
    showScreen('home-screen');
  }, 500);
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function prependHttps(url) {
  if (!/^https?:\/\//i.test(url)) {
    return 'https://' + url;
  }
  return url;
}

async function fetchAndDisplayHighScores(elementId, listRequestId = null) {
  const list = document.getElementById(elementId);
  if (!list) return;
  list.innerHTML = '<li class="home-score-loading">Loading…</li>';
  try {
    const querySnapshot = await getHighScores();
    if (listRequestId != null && listRequestId !== _endListRequestId) {
      return;
    }
    list.innerHTML = '';
    if (querySnapshot.empty) {
      list.innerHTML =
        '<li class="home-score-empty">No scores yet — be the first!</li>';
      return;
    }
    querySnapshot.docs.forEach((doc, i) => {
      const data = doc.data();
      const isMe = mySubmittedScore &&
        data.name === mySubmittedScore.name &&
        data.score.toFixed(2) === mySubmittedScore.score.toFixed(2);
      const li = document.createElement('li');
      li.className = 'home-score-entry' + (isMe ? ' is-mine' : '');
      let urlHTML = '';
      if (data.url && data.url.trim()) {
        const urlStr = prependHttps(data.url.trim());
        if (isValidUrl(urlStr)) {
          const hostname = new URL(urlStr).hostname;
          urlHTML = `<a class="home-score-url" href="${urlStr}" target="_blank" rel="noopener">${hostname}</a>`;
        }
      }
      const youPill = isMe ? '<span class="home-score-you">You</span>' : '';
      li.innerHTML = `
                <div class="home-score-left">
                    <span class="home-score-rank">${i + 1}.</span>
                    <div class="home-score-name-obj">
                        <span class="home-score-name">${data.name}</span>
                        ${urlHTML}
                    </div>
                    ${youPill}
                </div>
                <span class="home-score-value">${data.score.toFixed(2)}</span>
            `;
      list.appendChild(li);
    });
    staggerScoreItems(elementId);
    scrollMineIntoView(elementId);
  } catch (error) {
    if (listRequestId != null && listRequestId !== _endListRequestId) {
      return;
    }
    list.innerHTML = '<li class="home-score-empty">Could not load scores.</li>';
    console.error('Error fetching high scores:', error);
  }
}

// No client-side URL blacklist — enforce via Firestore security rules or a server-side function.
async function isUrlBlacklisted(_url) {
  return false;
}
