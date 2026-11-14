// confetti.js — tiny, dependency-free celebration burst. No-ops under reduced motion.

const COLORS = ['#f59e0b', '#fbbf24', '#d97706', '#fafafa', '#a3a3a3'];

let canvas = null;
let rafId = 0;

export function celebrate({ count = 90, originY = 0.35 } = {}) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const particles = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 6 + Math.random() * 7;
    return {
      x: w / 2 + (Math.random() - 0.5) * 40,
      y: h * originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 0,
      ttl: 70 + Math.random() * 40,
    };
  });

  cancelAnimationFrame(rafId);
  const step = () => {
    ctx.clearRect(0, 0, w, h);
    let alive = 0;
    for (const p of particles) {
      if (p.life >= p.ttl) continue;
      alive++;
      p.life++;
      p.vy += 0.28; // gravity
      p.vx *= 0.985; // drag
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (alive) {
      rafId = requestAnimationFrame(step);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
  };
  rafId = requestAnimationFrame(step);
}
