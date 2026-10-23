import { newEvent, newStore, sendCommand, update, updateStore } from './db.ts';
import { newCode } from './admins.ts';
import type { Admin, Player } from './types.ts';
import { addDaysLocal, todayLocal, uid } from './util.ts';

const NAMES = [
  'Aarav Shah', 'Meera Nair', 'Kabir Singh', 'Ishaan Rao', 'Zoya Khan', 'Rohan Mehta', 'Anaya Iyer', 'Vihaan Gupta',
  'Diya Menon', 'Arjun Pillai', 'Sara Das', 'Neel Joshi',
];

/** A sample event (with one admin) so the flows can be tried without real data. */
export function seedDemo() {
  const date = addDaysLocal(todayLocal(), 3);
  const ev = newEvent({ name: 'Campus Clash — City Qualifier', date, games: ['Valorant', 'Tekken 8'] });
  const a = newStore(ev.id, { name: 'Phoenix Mall', city: 'Pune', address: 'Level 2, Viman Nagar' });
  const b = newStore(ev.id, { name: 'Forum Galleria', city: 'Bengaluru', address: 'Koramangala' });

  const players: Player[] = NAMES.map((name, i) => ({ id: uid(), name, seed: i + 1 }));

  update((d) => {
    const rhea: Admin = { id: uid(), name: 'Rhea Kapoor', phone: '', code: newCode(Object.values(d.admins).map((x) => x.code)), createdAt: new Date().toISOString() };
    d.admins[rhea.id] = rhea;
    Object.assign(a, { adminId: rhea.id, admin: rhea.name });
    d.events[ev.id] = ev;
    d.stores[a.id] = a;
    d.stores[b.id] = b;
  });
  // The bracket is tournament state: it goes through the server-checked command, like any real load.
  // Check-ins are plain edits queued after it, so they reach the server once the players exist.
  sendCommand(a.id, { type: 'bracket.load', base: 0, players });
  const t = Date.now();
  updateStore(a.id, (s) => players.slice(0, 9).forEach((p, i) => (s.day.checkIn[p.id] = new Date(t - (40 - i * 3) * 60000).toISOString())));
  return ev.id;
}
