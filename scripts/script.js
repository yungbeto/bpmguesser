let actualBPM, startTime, timerInterval, metronomeInterval;
const gameArea = document.getElementById('game-area');
const resultArea = document.getElementById('result');
const countdownArea = document.getElementById('countdown');
const intermissionArea = document.getElementById('intermission');
const timerDisplay = document.getElementById('timer');
const scoreDisplay = document.getElementById('score');
const circle1 = document.getElementById('circle1');
const circle2 = document.getElementById('circle2');
const bpmGuessInput = document.getElementById('bpm-guess');
const submitGuessButton = document.getElementById('submit-guess');
    const inputLabel = document.querySelector('.input-label');
const currentRoundDisplay = document.getElementById('current-round');
const endGameButton = document.getElementById('end-game');
let audioContext, currentBeat = 0;
let currentRound = 1;
let totalScore = 0;
let roundResults = [];
let isCountdownActive = false;

document.getElementById('start-game').addEventListener('click', startGameCountdown);
document.getElementById('submit-guess').addEventListener('click', submitGuess);
document.getElementById('submit-score').addEventListener('click', submitHighScore);
document.getElementById('play-again').addEventListener('click', resetGame);
bpmGuessInput.addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitGuess();
    }
});
if (/Mobi|Android/i.test(navigator.userAgent)) {
    inputLabel.style.display = 'none';
}
endGameButton.addEventListener('click', endGame);

function changeBackgroundColor(isBlack) {
    document.body.style.backgroundColor = isBlack ? '#000000' : '#FFFFFF';
    document.body.style.color = isBlack ? '#FFFFFF' : '#000000';
    
    // Update button colors
    const buttons = document.querySelectorAll('.button');
    buttons.forEach(button => {
        button.style.backgroundColor = isBlack ? '#FFFFFF' : '#000000';
        button.style.color = isBlack ? '#000000' : '#FFFFFF';
    });
    
    // Update input colors
    const inputs = document.querySelectorAll('.input');
    inputs.forEach(input => {
        input.style.backgroundColor = isBlack ? '#000000' : '#FFFFFF';
        input.style.color = isBlack ? '#FFFFFF' : '#000000';
        input.style.borderColor = isBlack ? '#FFFFFF' : '#000000';
    });
}

function startGameCountdown() {
    document.getElementById('start-game').style.display = 'none';
    document.getElementById('scoring-explanation').style.display = 'none';
    endGameButton.style.display = 'block';
    countdownArea.style.display = 'block';
    changeBackgroundColor(true); // Black background for countdown
    let count = 3;
    countdownArea.textContent = 'Get ready...';
    
    isCountdownActive = true;
    
    const countInterval = setInterval(() => {
        if (count > 0) {
            countdownArea.textContent = count;
            count--;
        } else {
            clearInterval(countInterval);
            countdownArea.style.display = 'none';
            changeBackgroundColor(false); // White background for game
            isCountdownActive = false;
            startRound();
        }
    }, 1000);
}

function startRound() {
    intermissionArea.style.display = 'none';
    gameArea.style.display = 'block';
    currentRoundDisplay.textContent = currentRound;
    actualBPM = Math.floor(Math.random() * (180 - 60 + 1)) + 60; // Random BPM between 60 and 180
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    scoreDisplay.textContent = totalScore.toFixed(2);
    resetCircles();
    bpmGuessInput.value = '';
    bpmGuessInput.focus();
    startMetronome();
}

function startMetronome() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const interval = 60000 / actualBPM; // Calculate interval in milliseconds
    metronomeInterval = setInterval(() => {
        playMetronomeSound(currentBeat % 2 === 0);
        updateVisualMetronome();
    }, interval);
}

function stopMetronome() {
    clearInterval(metronomeInterval);
    resetCircles();
    if (audioContext) {
        audioContext.close().then(() => {
            audioContext = null;
        });
    }
}

function playMetronomeSound(isTick) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(isTick ? 1000 : 800, audioContext.currentTime); // Higher pitch for tick, lower for tock
    
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.1);
}

function updateVisualMetronome() {
    resetCircles();
    if (currentBeat % 2 === 0) {
        circle1.classList.add('active');
    } else {
        circle2.classList.add('active');
    }
    currentBeat++;
}

function resetCircles() {
    circle1.classList.remove('active');
    circle2.classList.remove('active');
}

function submitGuess() {
    clearInterval(timerInterval);
    stopMetronome();
    const guessedBPM = parseInt(bpmGuessInput.value);
    const timeTaken = (Date.now() - startTime) / 1000;
    const roundScore = calculateScore(guessedBPM, timeTaken);
    totalScore += roundScore;
    
    roundResults.push({
        round: currentRound,
        actualBPM: actualBPM,
        guessedBPM: guessedBPM,
        score: roundScore,
        timeTaken: timeTaken
    });

    if (currentRound < 3) {
        showIntermission();
    } else {
        showFinalResults();
    }
}

function calculateScore(guess, time) {
    const maxScore = 100;
    const timePenaltyThreshold = 2; // seconds
    const maxBPMDifference = 20; // Maximum BPM difference for scoring

    // Calculate accuracy penalty
    const bpmDifference = Math.abs(actualBPM - guess);
    let accuracyPenalty = 0;
    if (bpmDifference <= maxBPMDifference) {
        // Use a square root function to make the penalty increase more slowly
        accuracyPenalty = Math.sqrt(bpmDifference / maxBPMDifference) * maxScore;
    } else {
        return 0; // Score is 0 if guess is off by more than maxBPMDifference
    }

    // Calculate time penalty
    let timePenalty = 0;
    if (time > timePenaltyThreshold) {
        timePenalty = Math.min(maxScore, (time - timePenaltyThreshold) * 0.5);
    }

    // Calculate final score
    const finalScore = Math.max(0, maxScore - accuracyPenalty - timePenalty);

    // Round to two decimal places
    return Math.round(finalScore * 100) / 100;
}

function showIntermission() {
    gameArea.style.display = 'none';
    intermissionArea.style.display = 'block';
    changeBackgroundColor(true); // Black background for intermission
    intermissionArea.textContent = `Nice guess! Get ready for round ${currentRound + 1}`;
    currentRound++;
    setTimeout(() => {
        intermissionArea.style.display = 'none';
        changeBackgroundColor(false); // White background for game
        startRound();
    }, 3000); // 3-second pause between rounds
}

function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerDisplay.textContent = elapsed;
}

function endGame() {
    stopMetronome();
    clearInterval(timerInterval);
    if (isCountdownActive) {
        resetGame();
    } else {
        showFinalResults();
    }
}

function showFinalResults() {
    gameArea.style.display = 'none';
    intermissionArea.style.display = 'none';
    countdownArea.style.display = 'none';
    resultArea.style.display = 'block';
    endGameButton.style.display = 'none';
    changeBackgroundColor(true); // Black background for results
    document.getElementById('final-score').textContent = totalScore.toFixed(2);

    const roundResultsDiv = document.getElementById('round-results');
    roundResultsDiv.innerHTML = roundResults.map(result => 
        `<div class="round-result">
            <h3>Round ${result.round}</h3>
            <p>Actual BPM: ${result.actualBPM}</p>
            <p>Your guess: ${result.guessedBPM}</p>
            <p>Time taken: ${result.timeTaken.toFixed(2)} seconds</p>
            <p>Score: ${result.score.toFixed(2)}</p>
        </div>`
    ).join('');

    document.getElementById('scoring-explanation').style.display = 'block';

    // Check if it's a high score (you'd implement this check against your database)
    const isHighScore = true; // Placeholder
    if (isHighScore) {
        document.getElementById('high-score-form').style.display = 'block';
    }
}

function changeBackgroundColor(color) {
    document.body.style.backgroundColor = color;
}

function submitHighScore() {
    const playerName = document.getElementById('player-name').value;
    // Here you would send the score to your backend
    console.log(`Submitting high score: ${playerName} - ${totalScore.toFixed(2)}`);
}

function resetGame() {
    // Reset all game variables
    currentRound = 1;
    totalScore = 0;
    roundResults = [];
    isCountdownActive = false;
    
    // Hide all game areas and show start game button and scoring explanation
    gameArea.style.display = 'none';
    resultArea.style.display = 'none';
    countdownArea.style.display = 'none';
    intermissionArea.style.display = 'none';
    document.getElementById('start-game').style.display = 'block';
    document.getElementById('scoring-explanation').style.display = 'block';
    endGameButton.style.display = 'none';
    
    changeBackgroundColor(false);
    
    // Clear any existing intervals
    clearInterval(timerInterval);
    clearInterval(metronomeInterval);
    
    // Reset audio context
    if (audioContext) {
        audioContext.close().then(() => {
            audioContext = null;
        });
    }

    // Update scoring explanation
    updateScoringExplanation();
}

function updateScoringExplanation() {
    const scoringDetails = document.getElementById('scoring-details');
    scoringDetails.innerHTML = `
        <ul>
            <li>Perfect score: 100 points per round</li>
            <li>Accuracy: Lose points based on how far your guess is from the actual BPM, with smaller errors penalized less harshly</li>
            <li>Speed: No penalty for the first 2 seconds, then lose 0.5 points per second</li>
            <li>Guesses more than 20 BPM off score 0 points</li>
            <li>Aim for accurate guesses, but don't worry too much about small errors!</li>
        </ul>
    `;
}

// Call this function when the page loads to ensure the scoring explanation is visible initially
document.addEventListener('DOMContentLoaded', updateScoringExplanation);
