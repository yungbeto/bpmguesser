// gameLogic.js
export function calculateScore(actualBPM, guessedBPM, timeTaken) {
    const maxScore = 100;
    const timePenaltyThreshold = 2;
    const maxBPMDifference = 20;

    const bpmDifference = Math.abs(actualBPM - guessedBPM);
    let accuracyPenalty = 0;
    if (bpmDifference <= maxBPMDifference) {
        accuracyPenalty = Math.sqrt(bpmDifference / maxBPMDifference) * maxScore;
    } else {
        return 0;
    }

    let timePenalty = 0;
    if (timeTaken > timePenaltyThreshold) {
        timePenalty = Math.min(maxScore, (timeTaken - timePenaltyThreshold) * 0.5);
    }

    const finalScore = Math.max(0, maxScore - accuracyPenalty - timePenalty);

    return Math.round(finalScore * 100) / 100;
}

export function generateRandomBPM() {
    return Math.floor(Math.random() * (180 - 60 + 1)) + 60;
}
