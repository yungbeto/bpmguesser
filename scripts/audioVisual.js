// audioVisual.js
let audioContext;

export function initAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

export function getAudioContext() {
    return audioContext;
}

export function playMetronomeSound(scheduledTime, isTick) {
    if (navigator.vibrate) navigator.vibrate(10);

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(isTick ? 1000 : 800, scheduledTime);

    gainNode.gain.setValueAtTime(0.2, scheduledTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, scheduledTime + 0.1);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(scheduledTime);
    oscillator.stop(scheduledTime + 0.1);
}

export function updateVisualMetronome(circle) {
    circle.classList.remove('beat-pulse');
    void circle.offsetWidth;
    circle.classList.add('beat-pulse');
}

export function changeBackgroundColor(isDark) {
    if (isDark) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
}
