// audioVisual.js
let audioContext;

export function initAudio() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

export function playMetronomeSound(isTick) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(isTick ? 1000 : 800, audioContext.currentTime);
    
    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.1);
}

export function updateVisualMetronome(circle1, circle2, currentBeat) {
    circle1.classList.remove('active');
    circle2.classList.remove('active');
    if (currentBeat % 2 === 0) {
        circle1.classList.add('active');
    } else {
        circle2.classList.add('active');
    }
}

export function changeBackgroundColor(isDark) {
    if (isDark) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
}
