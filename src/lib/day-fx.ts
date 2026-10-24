/*
 * Small browser-side helpers for match-day motion: "did this just change?" and the reduced-motion
 * switch. Kept apart from day-ui.ts, which stays pure so Node tests can load it.
 */
import { useEffect, useRef, useState } from 'react';

/** True when the visitor asked for less motion. Read when needed, so a change in settings is picked up. */
export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Ids that appear in `ids` after the first render, each kept in the returned set for `ms`.
 * The first render never counts (a page opened with 18 people already in should not cheer 18 times),
 * and an id that was there before and comes back later is "fresh" again.
 */
export function useFreshIds(ids: string[], ms = 1600): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const key = ids.join('|');
  useEffect(() => {
    const prev = known.current;
    known.current = new Set(ids);
    if (!prev) return;
    const added = ids.filter((id) => !prev.has(id));
    if (!added.length) return;
    setFresh((f) => new Set([...f, ...added]));
    timers.current.push(
      setTimeout(() => {
        setFresh((f) => {
          const rest = new Set(f);
          for (const id of added) rest.delete(id);
          return rest;
        });
      }, ms),
    );
  }, [key]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return fresh;
}
