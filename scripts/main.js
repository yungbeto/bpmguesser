// main.js
import { getHighScores, addHighScore } from './firebase.js';
import { calculateScore, generateRandomBPM } from './gameLogic.js';
import { initAudio, playMetronomeSound, updateVisualMetronome, changeBackgroundColor } from './audioVisual.js';

const simpleProfanityList = ['badword', 'anotherbadword']; // Add more words as needed
function containsBadWords(text) {
    return simpleProfanityList.some(word => text.toLowerCase().includes(word));
}

let actualBPM, startTime, timerInterval, metronomeInterval, countInterval;
let currentBeat = 0;
let currentRound = 1;
let totalScore = 0;
let roundResults = [];
let isCountdownActive = false;

// DOM elements
const gameArea = document.getElementById('game-area');
const homeScreen = document.getElementById('home-screen');
const endScreen = document.getElementById('end-screen');
const countdownScreen = document.getElementById('countdown-screen');
const intermissionScreen = document.getElementById('intermission-screen');
const countdownArea = document.querySelector('#countdown-screen .countdown');
const intermissionArea = document.querySelector('#intermission-screen .intermission');
const timerDisplay = document.getElementById('timer');
const scoreDisplay = document.getElementById('score');
const circle1 = document.querySelector('.game-container #circle1');
const circle2 = document.querySelector('.game-container #circle2');
console.log(circle1, circle2); // Check if these are null or undefined

const bpmGuessInput = document.querySelector('.game-container #bpm-guess');
const currentRoundDisplay = document.getElementById('current-round');
const endGameButton = document.getElementById('end-game');
const openModalLink = document.getElementById('open-scoring-modal');
const closeModalButton = document.getElementById('close-scoring-modal');
const scoringExplanationLink = document.getElementById('open-scoring-modal');

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM content loaded');
    initAudio();
    fetchAndDisplayHighScores('high-scores-list');
    showScreen('home-screen'); // Ensure only the home screen is shown initially
    document.getElementById('start-game').addEventListener('click', () => {
        console.log('Start game clicked');
        showScreen('countdown-screen');
        startGameCountdown();
    });
    document.getElementById('submit-guess').addEventListener('click', submitGuess);
    document.getElementById('submit-score-check').addEventListener('click', submitHighScoreCheck);
    document.getElementById('continue-to-final').addEventListener('click', () => {
        console.log('Continue to final clicked');
        showFinalScreen();
    });
    document.getElementById('skip-high-score').addEventListener('click', () => {
        console.log('Skip high score clicked');
        document.getElementById('skip-high-score').disabled = true; // Disable the button
        showFinalScreen();
    });
    document.getElementById('play-again').addEventListener('click', resetGame);
    bpmGuessInput.addEventListener('keypress', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitGuess();
        }
    });
    bpmGuessInput.addEventListener('wheel', function(event) {
        event.preventDefault();
    }, { passive: false });

    endGameButton.addEventListener('click', endGame);

    // Modal functionality
    openModalLink.addEventListener('click', (event) => {
        event.preventDefault();
        updateScoringExplanation();
        document.getElementById('scoring-explanation').style.display = 'block';
        document.getElementById('scoring-modal').style.display = 'block';
    });

    closeModalButton.addEventListener('click', () => {
        document.getElementById('scoring-modal').style.display = 'none';
        document.getElementById('scoring-explanation').style.display = 'none';
    });

    window.addEventListener('click', (event) => {
        if (event.target === document.getElementById('scoring-modal')) {
            document.getElementById('scoring-modal').style.display = 'none';
            document.getElementById('scoring-explanation').style.display = 'none';
        }
    });

    // Hide the scoring explanation div until modal is opened
    document.getElementById('scoring-explanation').style.display = 'none';
});

function showScreen(screenId) {
    console.log(`Showing screen: ${screenId}`);
    // Remove 'active' class from all screens and hide them
    const screens = document.querySelectorAll('.screen');
    screens.forEach(screen => {
        screen.classList.remove('active');
        screen.style.display = 'none';
        console.log(`Removed 'active' class from ${screen.id}`);
    });

    // Add 'active' class to the selected screen and show it
    const activeScreen = document.getElementById(screenId);
    activeScreen.classList.add('active');
    activeScreen.style.display = 'flex';
    console.log(`Added 'active' class to ${screenId}`);

    // Scroll to the top of the newly active screen
    activeScreen.scrollTop = 0;

    // Special handling for game area
    if (screenId === 'game-area') {
        document.body.style.overflow = 'hidden'; // Prevent scrolling on game screen
    } else {
        document.body.style.overflow = ''; // Allow scrolling on other screens
    }
}

function startGameCountdown() {
    endGameButton.style.display = 'block'; // Show the end game button
    scoringExplanationLink.style.display = 'none'; // Hide the scoring explanation link
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

    // Delay the access to ensure that the screen is fully visible
    setTimeout(() => {
        const currentRoundDisplay = document.getElementById('current-round');
        console.log('currentRoundDisplay:', currentRoundDisplay);
        if (!currentRoundDisplay) {
            console.error('currentRoundDisplay not found in DOM');
            return;
        }

        currentRoundDisplay.textContent = currentRound;  // Setting the round number here

        actualBPM = generateRandomBPM();
        startTime = Date.now();
        timerInterval = setInterval(updateTimer, 1000);

        // Ensure that scoreDisplay is also present before setting its value
        if (scoreDisplay) {
            scoreDisplay.textContent = totalScore.toFixed(2);
        } else {
            console.error('scoreDisplay not found in DOM');
        }

        resetCircles();
        bpmGuessInput.value = '';

        // Delay focus to ensure it works after everything is visible
        setTimeout(() => {
            bpmGuessInput.focus();
        }, 200);  // Increased delay slightly to ensure everything is loaded

        startMetronome();
    }, 300);  // Increased delay to ensure that DOM is ready
}




function startMetronome() {
    const interval = 60000 / actualBPM;
    currentBeat = 0;
    metronomeInterval = setInterval(() => {
        playMetronomeSound(currentBeat % 2 === 0);
        updateVisualMetronome(circle1, circle2, currentBeat);
        currentBeat++;
    }, interval);
}

function stopMetronome() {
    clearInterval(metronomeInterval);
    resetCircles();
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
    const roundScore = calculateScore(actualBPM, guessedBPM, timeTaken);
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

function showIntermission() {
    showScreen('intermission-screen');
    changeBackgroundColor(true);
    let count = 3;
    intermissionArea.innerHTML = `
        <div class="intermission-headline">Get ready for round ${currentRound + 1}</div>
        <div class="intermission-countdown">${count}</div>
    `;

    const intermissionInterval = setInterval(() => {
        if (count > 0) {
            document.querySelector('.intermission-countdown').textContent = count;
            count--;
        } else {
            clearInterval(intermissionInterval);
            changeBackgroundColor(false);
            currentRound++; // Increment the round here
            startRound();
        }
    }, 1000);
}

function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    timerDisplay.textContent = elapsed;
}

function endGame() {
    clearInterval(metronomeInterval);
    clearInterval(timerInterval);

    if (isCountdownActive) {
        clearInterval(countInterval);
        isCountdownActive = false;
    }

    if (roundResults.length === 0) {
        // If no rounds were played, add a dummy round with 0 score
        roundResults.push({
            round: 1,
            actualBPM: 0,
            guessedBPM: 0,
            score: 0,
            timeTaken: 0
        });
    }

    showFinalResults();

    endGameButton.style.display = 'none'; // Hide the end game button
    changeBackgroundColor(false);
}

function showFinalResults() {
    console.log('Showing final results');
    endGameButton.style.display = 'none'; // Hide the end game button
    document.getElementById('final-score-check').textContent = totalScore.toFixed(2);
    checkAndHandleHighScore();
}

async function checkAndHandleHighScore() {
    console.log('Checking high score');
    if (totalScore <= 50) {
        console.log('Score is 50 or below, showing final screen');
        showFinalScreen();
        return;
    }

    try {
        const querySnapshot = await getHighScores();

        let isHighScore = false;
        if (querySnapshot.size < 10) {
            isHighScore = true;
        } else {
            const lowestHighScore = querySnapshot.docs[querySnapshot.size - 1].data().score;
            if (totalScore > lowestHighScore) {
                isHighScore = true;
            }
        }

        showScreen('high-score-check');

        if (isHighScore) {
            console.log('New high score achieved');
            document.getElementById('high-score-input-area').style.display = 'flex';
            document.getElementById('no-high-score-area').style.display = 'none';
            document.getElementById('player-name-check').value = '';
            document.getElementById('player-url-check').value = '';
        } else {
            console.log('Not a high score');
            document.getElementById('high-score-input-area').style.display = 'none';
            document.getElementById('no-high-score-area').style.display = 'flex';
        }
    } catch (error) {
        console.error('Error checking high score:', error);
        showFinalScreen();
    }
}

async function submitHighScoreCheck() {
    console.log('Submitting high score');
    const playerName = document.getElementById('player-name-check').value;
    let playerUrl = document.getElementById('player-url-check').value.trim();
    
    if (!playerName) {
        alert("Please enter your name.");
        return;
    }

    if (containsBadWords(playerName)) {
        alert("Please use appropriate language for your name.");
        return;
    }

    if (playerUrl) {
        playerUrl = prependHttps(playerUrl);
        if (!isValidUrl(playerUrl)) {
            alert("Please enter a valid URL or leave the field empty.");
            return;
        }
        if (await isUrlBlacklisted(playerUrl)) {
            alert("This URL is not allowed.");
            return;
        }
    }

    // Show loading indicator
    const submitButton = document.getElementById('submit-score-check');
    const loadingIndicator = document.getElementById('loading-indicator');
    submitButton.style.display = 'none';
    loadingIndicator.style.display = 'block';

    try {
        console.log('Adding high score to database');
        await addHighScore(playerName, totalScore, playerUrl);
        console.log('High score added successfully');
    } catch (error) {
        console.error("Error adding high score: ", error);
    } finally {
        // Hide loading indicator
        submitButton.style.display = 'block';
        loadingIndicator.style.display = 'none';
        
        // Show final screen
        showFinalScreen();
    }
}

function showFinalScreen() {
    console.log('Inside showFinalScreen function');
    gameArea.style.display = 'none';
    showScreen('end-screen');
    console.log('Showed end-screen');
    endGameButton.style.display = 'none'; // Hide the end game button
    scoringExplanationLink.style.display = 'block'; // Show the scoring explanation link
    document.getElementById('final-score').textContent = totalScore.toFixed(2);
    const roundResultsDiv = document.getElementById('round-results');
    if (roundResults.length > 0) {
        roundResultsDiv.innerHTML = roundResults.map(result =>
            `<div class="round-result">
                <div class="round-result-header">
                    <h3 class="round-result-title">Round ${result.round}</h3>
                    <span class="round-result-score">${result.score.toFixed(2)}</span>
                </div>
                <div class="result-details">
                    <div class="result-item">
                        <span class="result-label">Actual BPM</span>
                        <span class="result-value">${result.actualBPM}</span>
                    </div>
                    <div class="result-item">
                        <span class="result-label">Your guess</span>
                        <span class="result-value">${result.guessedBPM}</span>
                    </div>
                    <div class="result-item">
                        <span class="result-label">Time</span>
                        <span class="result-value">${result.timeTaken.toFixed(2)}s</span>
                    </div>
                </div>
            </div>`
        ).join('');
    } else {
        roundResultsDiv.innerHTML = '<p>No rounds played.</p>';
    }
    console.log('Round results added to DOM');

    document.getElementById('scoring-explanation').style.display = 'none';
    fetchAndDisplayHighScores('high-scores-list-end');
    console.log('Fetched and displayed high scores');
}

function resetGame() {
    currentRound = 1;
    totalScore = 0;
    roundResults = [];
    isCountdownActive = false;

    endGameButton.style.display = 'none'; // Hide the end game button
    changeBackgroundColor(false);

    clearInterval(timerInterval);
    clearInterval(metronomeInterval);

    scoringExplanationLink.style.display = 'block'; // Show the scoring explanation link
    fetchAndDisplayHighScores('high-scores-list');

    // Add a fade-out effect before showing the home screen
    const endScreen = document.getElementById('end-screen');
    endScreen.style.opacity = 0; // Start fade-out

    setTimeout(() => {
        gameArea.style.display = 'none';
        showScreen('home-screen');
    }, 500); // Wait for the fade-out to complete
}

function updateScoringExplanation() {
    const scoringDetails = document.getElementById('scoring-details');
    if (!scoringDetails) {
        return;
    }

    scoringDetails.innerHTML = `
<p>
For each round the max score is 100 points. Your score depends on both accuracy and speed. The closer your guess is to the actual BPM, the higher your score will be.
</p>
<p>
Speed also plays a role: if you make your guess within the first 2 seconds, there's no penalty. After that, you'll lose 0.5 points for every second you delay. 

Additionally, if your guess is more than 20 BPM away from the correct answer, you won’t score any points for that round.
</p>
<p>
This game was conceived and developed by <a href="https://robysaavedra.com" target="_blank">Roby Saavedra</a>.
</p>
    `;
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

async function fetchAndDisplayHighScores(elementId) {
    try {
        const querySnapshot = await getHighScores();
        const highScoresList = document.getElementById(elementId);

        highScoresList.innerHTML = '';
        
        if (querySnapshot.empty) {
            console.log('No high scores found');
            highScoresList.innerHTML = '<li>No high scores yet!</li>';
            return;
        }

        querySnapshot.docs.forEach((doc, index) => {
            const data = doc.data();
            const listItem = document.createElement('li');
            listItem.classList.add('high-score-item');
            
            const numberSpan = document.createElement('span');
            numberSpan.textContent = `${index + 1}.`;
            numberSpan.classList.add('high-score-number');
            
            const nameUrlContainer = document.createElement('div');
            nameUrlContainer.classList.add('high-score-name-url');
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = data.name;
            nameSpan.classList.add('high-score-name');
            
            const urlSpan = document.createElement('span');
            urlSpan.classList.add('high-score-url-container');
            if (data.url && data.url.trim() !== '') {
                let urlToUse = prependHttps(data.url.trim());
                if (isValidUrl(urlToUse)) {
                    const urlObject = new URL(urlToUse);
                    const urlLink = document.createElement('a');
                    urlLink.href = urlObject.href;
                    urlLink.textContent = urlObject.hostname;
                    urlLink.target = "_blank";
                    urlLink.classList.add('high-score-url');
                    urlSpan.appendChild(urlLink);
                } else {
                    console.error("Invalid URL:", data.url);
                    urlSpan.textContent = data.url;
                }
            }
            
            const scoreSpan = document.createElement('span');
            scoreSpan.textContent = data.score.toFixed(2);
            scoreSpan.classList.add('high-score-score');
            
            nameUrlContainer.appendChild(nameSpan);
            nameUrlContainer.appendChild(urlSpan);
            
            const leftSide = document.createElement('div');
            leftSide.classList.add('high-score-left');
            leftSide.appendChild(numberSpan);
            leftSide.appendChild(nameUrlContainer);
            
            listItem.appendChild(leftSide);
            listItem.appendChild(scoreSpan);
            
            highScoresList.appendChild(listItem);
        });
        
        console.log(`Displayed ${querySnapshot.size} high scores`);
    } catch (error) {
        console.error("Error fetching high scores:", error);
    }
}

// Add this function to check URLs against a blacklist
async function isUrlBlacklisted(url) {
    // Hardcoded blacklist for testing
    const blacklistedDomains = ['badwebsite.com', 'anotherbadsite.com'];
    const domain = new URL(url).hostname;
    return blacklistedDomains.some(blacklistedDomain => domain.includes(blacklistedDomain));
}