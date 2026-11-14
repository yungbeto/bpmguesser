// gameLogic.js
export const TIME_PENALTY_THRESHOLD = 2; // seconds before penalty starts (used by timer UI)
export const TOTAL_ROUNDS = 3;

const MAX_ACCURACY_SCORE = 100;
export const MAX_ROUND_SCORE = 133; // MAX_ACCURACY_SCORE + MAX_SPEED_BONUS
export const MAX_TOTAL_SCORE = MAX_ROUND_SCORE * TOTAL_ROUNDS; // 399
const MAX_BPM_DIFFERENCE = 20;
const SPEED_WINDOW = 10; // seconds over which speed bonus decays to zero
const MAX_SPEED_BONUS = 33; // max bonus pts (instant guess); max total per round: 133
const TIME_PENALTY_AFTER = 2; // penalty starts here, independent of bonus window
const TIME_PENALTY_RATE = 0.5; // pts lost per second beyond TIME_PENALTY_AFTER

export function calculateScoreBreakdown(actualBPM, guessedBPM, timeTaken) {
  const bpmDifference = Math.abs(actualBPM - guessedBPM);

  if (bpmDifference >= MAX_BPM_DIFFERENCE) {
    return { accuracyScore: 0, speedBonus: 0, timePenalty: 0, finalScore: 0 };
  }

  const accuracyScore =
    (1 - bpmDifference / MAX_BPM_DIFFERENCE) * MAX_ACCURACY_SCORE;
  const speedBonus =
    Math.max(0, 1 - timeTaken / SPEED_WINDOW) * MAX_SPEED_BONUS;
  const timePenalty = Math.max(
    0,
    (timeTaken - TIME_PENALTY_AFTER) * TIME_PENALTY_RATE,
  );
  const finalScore =
    Math.round(Math.max(0, accuracyScore + speedBonus - timePenalty) * 100) /
    100;

  return {
    accuracyScore: Math.round(accuracyScore * 100) / 100,
    speedBonus: Math.round(speedBonus * 100) / 100,
    timePenalty: Math.round(timePenalty * 100) / 100,
    finalScore,
  };
}

export function calculateScore(actualBPM, guessedBPM, timeTaken) {
  return calculateScoreBreakdown(actualBPM, guessedBPM, timeTaken).finalScore;
}

/** Grade for a single round (0–133). */
export function getGrade(score) {
  if (score >= 90) return 'S';
  if (score >= 70) return 'A';
  if (score >= 50) return 'B';
  if (score >= 20) return 'C';
  return 'F';
}

/** Grade for a whole game: graded on the per-round average, so a 3-round total is comparable to one round. */
export function getGameGrade(totalScore) {
  return getGrade(totalScore / TOTAL_ROUNDS);
}

export const BPM_RANGES = [
  { min: 60, max: 180 }, // round 1: full range
  { min: 80, max: 160 }, // round 2: tighter, excludes obvious extremes
  { min: 95, max: 145 }, // round 3: hardest — midrange tempos are similar-sounding
];

const DAY_MS = 86400000;
const EPOCH_UTC = Date.UTC(2025, 0, 1);

/**
 * Daily challenge number for the player's local calendar date (Jan 1 2025 = #1).
 * Uses the local Y/M/D mapped onto UTC so DST shifts can't repeat or skip a day.
 * Native clients must use the same formula: days between 2025-01-01 and the local date, + 1.
 */
export function getDayNumber(date = new Date()) {
  const localMidnightAsUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((localMidnightAsUTC - EPOCH_UTC) / DAY_MS) + 1;
}

/** Deterministic per-day BPMs (LCG seeded with the day number) — identical for every player. */
export function generateDailyBPMs(dayNumber = getDayNumber()) {
  let s = dayNumber >>> 0;
  const rng = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return BPM_RANGES.map(
    ({ min, max }) => min + Math.floor(rng() * (max - min + 1)),
  );
}

export function generateRandomBPM(round = 1) {
  const { min, max } = BPM_RANGES[Math.min(round - 1, BPM_RANGES.length - 1)];
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
