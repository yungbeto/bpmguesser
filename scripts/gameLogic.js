// gameLogic.js
export const TIME_PENALTY_THRESHOLD = 5;
export const TOTAL_ROUNDS = 3;

export function calculateScore(actualBPM, guessedBPM, timeTaken) {
    const maxScore = 100;
    const maxBPMDifference = 20;

    const bpmDifference = Math.abs(actualBPM - guessedBPM);
    let accuracyPenalty = 0;
    if (bpmDifference <= maxBPMDifference) {
        accuracyPenalty = (bpmDifference / maxBPMDifference) * maxScore;
    } else {
        return 0;
    }

    let timePenalty = 0;
    if (timeTaken > TIME_PENALTY_THRESHOLD) {
        timePenalty = Math.min(maxScore, (timeTaken - TIME_PENALTY_THRESHOLD) * 0.5);
    }

    const finalScore = Math.max(0, maxScore - accuracyPenalty - timePenalty);

    return Math.round(finalScore * 100) / 100;
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
