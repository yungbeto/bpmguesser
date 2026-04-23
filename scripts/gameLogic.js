// gameLogic.js
export const TIME_PENALTY_THRESHOLD = 3; // seconds before penalty starts (used by timer UI)
export const TOTAL_ROUNDS = 3;

const MAX_ACCURACY_SCORE = 100;
const MAX_BPM_DIFFERENCE = 20;
const SPEED_WINDOW       = 10;  // seconds over which speed bonus decays to zero
const MAX_SPEED_BONUS    = 33;  // max bonus pts (instant guess); max total per round: 133
const TIME_PENALTY_AFTER = 3;   // penalty starts here, independent of bonus window
const TIME_PENALTY_RATE  = 0.5; // pts lost per second beyond TIME_PENALTY_AFTER

export function calculateScoreBreakdown(actualBPM, guessedBPM, timeTaken) {
    const bpmDifference = Math.abs(actualBPM - guessedBPM);

    if (bpmDifference > MAX_BPM_DIFFERENCE) {
        return { accuracyScore: 0, speedBonus: 0, timePenalty: 0, finalScore: 0 };
    }

    const accuracyScore = (1 - bpmDifference / MAX_BPM_DIFFERENCE) * MAX_ACCURACY_SCORE;
    const speedBonus    = Math.max(0, 1 - timeTaken / SPEED_WINDOW) * MAX_SPEED_BONUS;
    const timePenalty   = Math.max(0, (timeTaken - TIME_PENALTY_AFTER) * TIME_PENALTY_RATE);
    const finalScore    = Math.round(Math.max(0, accuracyScore + speedBonus - timePenalty) * 100) / 100;

    return {
        accuracyScore: Math.round(accuracyScore * 100) / 100,
        speedBonus:    Math.round(speedBonus    * 100) / 100,
        timePenalty:   Math.round(timePenalty   * 100) / 100,
        finalScore,
    };
}

export function calculateScore(actualBPM, guessedBPM, timeTaken) {
    return calculateScoreBreakdown(actualBPM, guessedBPM, timeTaken).finalScore;
}

export function getGrade(score) {
    if (score >= 90) return 'S';
    if (score >= 70) return 'A';
    if (score >= 50) return 'B';
    if (score >= 20) return 'C';
    return 'F';
}

export const BPM_RANGES = [
    { min: 60,  max: 180 }, // round 1: full range
    { min: 80,  max: 160 }, // round 2: tighter, excludes obvious extremes
    { min: 95,  max: 145 }, // round 3: hardest — midrange tempos are similar-sounding
];

export function getDayNumber() {
    const epoch = new Date(2025, 0, 1);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.floor((now - epoch) / 86400000) + 1;
}

export function generateDailyBPMs() {
    let s = getDayNumber() >>> 0;
    const rng = () => {
        s = Math.imul(s, 1664525) + 1013904223 >>> 0;
        return s / 0x100000000;
    };
    return BPM_RANGES.map(({ min, max }) => min + Math.floor(rng() * (max - min + 1)));
}

export function generateRandomBPM(round = 1) {
    const { min, max } = BPM_RANGES[Math.min(round - 1, BPM_RANGES.length - 1)];
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
