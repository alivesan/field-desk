/*
 * Winner and runner-up details: cleaning what the desk types (shared by the winners.set handler
 * and the form, so the form can say what the server will say) and reading the state of a store's
 * winners against its bracket. Pure, Node-loadable.
 */
import type { Match, MatchDay, WinnerDetails } from './types.ts';
import type { WinnerInput } from './command-types.ts';
import { cleanIgn, isPhone, MAX_IGN, normalizePhone } from './phone.ts';
import { roundCount } from './bracket.ts';

export const MAX_REAL_NAME = 100;
export const MAX_EMAIL = 200;
export const MAX_INSTAGRAM = 30;
/** A stored Instagram handle: letters, digits, '.' and '_' (no '@', no URL). */
export const INSTAGRAM_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Who = 'Winner' | 'Runner-up';
type Details = Omit<WinnerDetails, 'playerId'>;

/** "@asha", "asha", "https://www.instagram.com/asha/?hl=en" → "asha"; null if it can't be an Instagram handle; '' for nothing typed. */
export function parseInstagram(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  const url = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(.*)$/i.exec(s);
  if (url) s = url[1].split(/[/?#]/)[0];
  s = s.replace(/^@+/, '');
  return INSTAGRAM_HANDLE.test(s) ? s.toLowerCase() : null;
}

/** Lower-cased email, '' for nothing typed, null if it doesn't look like x@y.z. */
export function parseEmail(raw: string): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.length <= MAX_EMAIL && EMAIL_SHAPE.test(s) ? s : null;
}

/** What one person's typed details become, or the first problem as a plain sentence ("Winner’s email doesn’t look right."). */
export function cleanWinnerInput(input: unknown, who: Who): { ok: true; value: Details } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(`${who}’s details are missing.`);
  const i = input as Record<string, unknown>;
  for (const k of ['realName', 'ign', 'phone', 'email', 'instagram'])
    if (i[k] !== undefined && typeof i[k] !== 'string') return fail(`${who}’s ${k === 'realName' ? 'name' : k} should be text.`);
  const realName = String(i.realName ?? '').replace(/\s+/g, ' ').trim();
  if (realName.length > MAX_REAL_NAME) return fail(`${who}’s name is longer than ${MAX_REAL_NAME} characters.`);
  const ign = cleanIgn(String(i.ign ?? ''));
  if (ign.length > MAX_IGN) return fail(`${who}’s in-game name is longer than ${MAX_IGN} characters.`);
  const typedPhone = String(i.phone ?? '').trim();
  if (typedPhone && !isPhone(typedPhone)) return fail(`${who}’s phone number doesn’t look right — type 8–15 digits, or leave it empty.`);
  const email = parseEmail(String(i.email ?? ''));
  if (email === null) return fail(`${who}’s email doesn’t look right.`);
  const instagram = parseInstagram(String(i.instagram ?? ''));
  if (instagram === null) return fail(`${who}’s Instagram doesn’t look right — letters, digits, “.” and “_” only, up to ${MAX_INSTAGRAM} characters.`);
  const out: Details = { realName };
  if (ign) out.ign = ign;
  if (typedPhone) out.phone = normalizePhone(typedPhone);
  if (email) out.email = email;
  if (instagram) out.instagram = instagram;
  return { ok: true, value: out };
}

export const WINNER_FIELDS = ['realName', 'phone', 'email', 'instagram'] as const;
export type WinnerField = (typeof WINNER_FIELDS)[number];
export const FIELD_LABEL: Record<WinnerField, string> = { realName: 'real name', phone: 'phone', email: 'email', instagram: 'Instagram' };

/** What's still empty for one person, in the order the form asks. */
export const missingFields = (d: Pick<WinnerDetails, WinnerField> | undefined): WinnerField[] => WINNER_FIELDS.filter((f) => !d?.[f]);

/** The minimum an admin must collect before the prize can be sent: a real name and a phone, for both. */
export const detailsComplete = (w: { winner: WinnerDetails; runnerUp: WinnerDetails } | undefined) =>
  !!w && [w.winner, w.runnerUp].every((d) => !!d.realName && !!d.phone);

/** The last round's match (the final), once the bracket has one. */
export const finalOf = (matches: Match[]): Match | null => matches.find((m) => m.round === roundCount(matches) - 1 && m.index === 0) ?? null;

export interface FinalResult {
  match: Match;
  winner: string; // player ids
  runnerUp: string;
}

/** The final's winner and the player they beat — null until the final has a result. */
export function finalResult(matches: Match[]): FinalResult | null {
  const f = finalOf(matches);
  if (!f || f.bye || f.status !== 'done' || !f.winner || !f.a || !f.b) return null;
  return { match: f, winner: f.winner, runnerUp: f.winner === f.a ? f.b : f.a };
}

export type WinnersState =
  | { kind: 'none' } // no bracket, or the final isn't played and nothing saved
  | { kind: 'collect'; result: FinalResult } // final done, nothing saved yet
  | { kind: 'saved'; result: FinalResult; missing: boolean } // saved and matching the final; missing = a real name or phone is still empty
  | { kind: 'manual'; missing: boolean } // HQ typed them (winners.manual): not tied to the bracket, so never stale
  | { kind: 'stale' }; // saved, but the final was undone or has other players now

export function winnersState(day: MatchDay): WinnersState {
  const result = finalResult(day.matches);
  const w = day.winners;
  if (w?.manual) return { kind: 'manual', missing: !detailsComplete(w) };
  if (!w) return result ? { kind: 'collect', result } : { kind: 'none' };
  if (!result || result.winner !== w.winner.playerId || result.runnerUp !== w.runnerUp.playerId) return { kind: 'stale' };
  return { kind: 'saved', result, missing: !detailsComplete(w) };
}
