/*
 * Tiny haptic taps for phones. navigator.vibrate exists on Android Chrome; iOS ignores it, and
 * that's fine - every call is a quiet no-op when it's unsupported or the visitor asked for reduced motion.
 */

function buzz(pattern: number | number[]) {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    navigator.vibrate(pattern);
  } catch {
    /* some embedded browsers throw - haptics are never worth an error */
  }
}

/** A light tick: a button press, a selection. */
export const tap = () => buzz(8);

/** Two short pulses: it worked (saved, checked in, result recorded). */
export const success = () => buzz([12, 40, 18]);

/** One longer buzz: something needs a second look (conflict, refused, offline). */
export const warn = () => buzz(45);
