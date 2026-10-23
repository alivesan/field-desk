import { update } from './db.ts';
import type { Admin, AppState, Store, TournamentEvent } from './types.ts';
import type { Role } from './db.ts';
import { uid } from './util.ts';
import { shareOrigin } from './origin.ts';

/** No 0/O, 1/I/L — codes get read out over the phone. Must match ADMIN_CODE on the server. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCode(taken: Iterable<string>) {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!used.has(code)) return code;
  }
}

export const adminLink = (code: string) => `${shareOrigin()}/${code}`; // the PC's Wi-Fi address when HQ is on localhost

export function addAdmin(name: string, phone: string) {
  let id = '';
  update((d) => {
    const a: Admin = { id: uid(), name: name.trim(), phone: phone.trim(), code: newCode(Object.values(d.admins).map((x) => x.code)), createdAt: new Date().toISOString() };
    d.admins[a.id] = a;
    id = a.id;
  });
  return id;
}

/** New code = old link stops working and that admin's devices are signed out. */
export function regenerateCode(adminId: string) {
  update((d) => {
    const a = d.admins[adminId];
    if (a) a.code = newCode(Object.values(d.admins).map((x) => x.code));
  });
}

export function renameAdmin(adminId: string, name: string) {
  update((d) => {
    const a = d.admins[adminId];
    if (!a) return;
    a.name = name;
    for (const s of Object.values(d.stores)) if (s.adminId === adminId) s.admin = name;
  });
}

export function removeAdmin(adminId: string) {
  update((d) => {
    delete d.admins[adminId];
    for (const s of Object.values(d.stores)) if (s.adminId === adminId) Object.assign(s, { adminId: null, admin: '' });
  });
}

export function assignStore(storeId: string, adminId: string | null) {
  update((d) => {
    const s = d.stores[storeId];
    if (!s) return;
    s.adminId = adminId;
    s.admin = adminId ? (d.admins[adminId]?.name ?? '') : '';
  });
}

export const storesFor = (state: AppState, adminId: string) => Object.values(state.stores).filter((s) => s.adminId === adminId);

/** Breadcrumbs for store pages: HQ goes back to the event, a field admin to their own list. */
export function storeCrumbs(role: Role | null, event: TournamentEvent, store: Store, ...rest: { label: string; href?: string }[]) {
  const head = role === 'admin' ? [{ label: 'My stores', href: '#/' }] : [{ label: event.name, href: `#/event/${event.id}` }];
  return [...head, { label: store.name, href: `#/store/${store.id}/recce` }, ...rest];
}
