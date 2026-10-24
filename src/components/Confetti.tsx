import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../lib/day-fx.ts';

/** Brand colours as they are in base.css: accent, ink, paper-3 — and a second accent so red leads. */
export const CONFETTI_PAPER = ['#c8361d', '#161513', '#e1dccf', '#c8361d'];
/** The same idea for the dark venue board, where ink would vanish. */
export const CONFETTI_DARK = ['#c8361d', '#f3f0e8', '#f2b25c', '#e1dccf'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  spin: number;
  color: string;
  round: boolean;
}

/**
 * A short confetti burst (~1.2 s) on a full-screen canvas that never takes a tap. Bump `run` to fire
 * it; `origin` says where from, in screen pixels (default: upper middle). Nothing at all is drawn
 * under reduced motion. No library: ~100 rectangles, a little gravity and drag, fading at the end.
 */
export function Confetti({ run, origin, colors = CONFETTI_PAPER, count = 90, duration = 1200 }: { run: number; origin?: () => { x: number; y: number } | null; colors?: string[]; count?: number; duration?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (run > 0 && !reducedMotion()) setActive(run);
  }, [run]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!active || !canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const at = origin?.() ?? { x: W / 2, y: H * 0.38 };
    const n = W < 500 ? Math.round(count * 0.7) : count;
    const pieces: Piece[] = Array.from({ length: n }, (_, i) => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15; // a fan, mostly upward
      const speed = 380 + Math.random() * 520; // px per second
      return {
        x: at.x + (Math.random() - 0.5) * 24,
        y: at.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 5 + Math.random() * 5,
        h: 8 + Math.random() * 7,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 14,
        color: colors[i % colors.length],
        round: i % 7 === 0,
      };
    });

    let raf = 0;
    let last = performance.now();
    const start = last;
    const frame = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      const age = t - start;
      ctx.clearRect(0, 0, W, H);
      const fade = age < duration * 0.7 ? 1 : Math.max(0, 1 - (age - duration * 0.7) / (duration * 0.3));
      for (const p of pieces) {
        p.vx *= 1 - 1.6 * dt; // air drag
        p.vy = p.vy * (1 - 1.1 * dt) + 1100 * dt; // gravity
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.scale(1, Math.abs(Math.cos(p.rot * 1.7)) * 0.8 + 0.2); // a tumbling flake
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          if (p.color === '#e1dccf') {
            ctx.strokeStyle = 'rgba(22, 21, 19, 0.3)'; // paper-3 on paper needs an edge to register
            ctx.lineWidth = 1;
            ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
          }
        }
        ctx.restore();
      }
      if (age < duration) raf = requestAnimationFrame(frame);
      else setActive(0);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return active ? createPortal(<canvas ref={ref} className="confetti" aria-hidden />, document.body) : null;
}
