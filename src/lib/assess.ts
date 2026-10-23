import type { PhotoRef, Recce, Store, SubmissionPolicy, TournamentEvent } from './types.ts';
import { distanceM, ONSITE_RADIUS_M, POOR_ACCURACY_M } from './geo.ts';
import { readRecce, reccePhotoRefs, venueRef, venueRefKind } from './recce.ts';
import { hasDownload } from './speedtest.ts';
import { fmtDateTime } from './util.ts';

export type SectionKey = 'venue' | 'furniture' | 'laptops' | 'network' | 'collateral';

export interface SectionStatus {
  key: SectionKey;
  title: string;
  done: boolean;
  todo: string[]; // what's still missing to complete the section
  issues: string[]; // completed but worth flagging to HQ
}

export interface Assessment {
  sections: SectionStatus[];
  progress: number; // 0..1
  issues: string[];
  photoFlags: Record<string, string[]>;
  verdict: 'incomplete' | 'attention' | 'ready';
  policy: SubmissionPolicy; // the requirements this assessment used
}

export const SECTION_TITLES: Record<SectionKey, string> = {
  venue: 'Venue',
  furniture: 'Setup',
  laptops: 'Laptops',
  network: 'Internet',
  collateral: 'Collateral',
};

/** A gallery photo older than this (by its own EXIF time) gets flagged. */
const STALE_UPLOAD_MS = 12 * 3600 * 1000;
/** A device fix measured this long before the photo was saved doesn't stand for where it was taken. */
const STALE_FIX_MS = 2 * 60 * 1000;

const fmtDist = (d: number) => (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m');

/**
 * What HQ should double-check about one proof photo. Advisory: the app can say what it
 * measured, not prove where or when a picture was taken.
 */
export function photoFlags(p: PhotoRef, store: Store): string[] {
  const f: string[] = [];
  const upload = p.source === 'upload' || (!p.source && !p.live);
  if (upload) {
    if (!p.shotAt) f.push('Uploaded — the photo has no capture time; check its own stamp');
    else if (Date.parse(p.takenAt) - Date.parse(p.shotAt) > STALE_UPLOAD_MS) f.push(`Photo was taken ${fmtDateTime(p.shotAt)}`);
  } else if (p.live === false) {
    // The camera input is only a hint — the phone can hand back an older picture.
    f.push(`Not taken just now — the camera returned a file from ${fmtDateTime(p.fileTime)}`);
  }
  if (!p.geo) f.push(upload ? 'No GPS in the photo — check its own stamp' : p.geoError ? `No location — ${p.geoError.toLowerCase()}` : 'No location');
  else {
    if (p.geo.accuracy > POOR_ACCURACY_M) f.push(`Location only accurate to ±${fmtDist(p.geo.accuracy)}`);
    if (p.geoFrom === 'device' && p.geoAt && Math.abs(Date.parse(p.takenAt) - Date.parse(p.geoAt)) > STALE_FIX_MS) f.push(`Location was measured ${fmtDateTime(p.geoAt)}, not when the photo was taken`);
    const ref = venueRef(store);
    if (ref) {
      const d = distanceM(p.geo, ref);
      if (d > ONSITE_RADIUS_M) f.push(`${fmtDist(d)} from the venue${venueRefKind(store) === 'provisional' ? ' pin (set from the first photo, not verified by HQ)' : ''}`);
    }
  }
  return f;
}

/** The requirements a recce is held to: a submission's frozen copy, or the campaign's current settings. */
export const policyOf = (event: TournamentEvent): SubmissionPolicy => ({ games: [...event.games], gameReadyTarget: event.gameReadyTarget, minDownMbps: event.minDownMbps });

export interface AssessOptions {
  /** Assess this recce instead of the store's working draft (e.g. a submitted revision). */
  recce?: Recce;
  /** Hold it to these requirements instead of the campaign's current ones. */
  policy?: SubmissionPolicy;
}

export function assess(event: TournamentEvent, store: Store, opts: AssessOptions = {}): Assessment {
  const pol = opts.policy ?? policyOf(event);
  const r = readRecce(opts.recce ?? store.recce);
  const sections: SectionStatus[] = [];
  const add = (key: SectionKey, todo: (string | false)[], issues: (string | false)[] = []) => {
    const t = todo.filter(Boolean) as string[];
    sections.push({ key, title: SECTION_TITLES[key], done: t.length === 0, todo: t, issues: issues.filter(Boolean) as string[] });
  };

  add('venue', [!r.venue.photos.length && 'Photo of the play area']);

  {
    const f = r.furniture;
    const standard = f.setup === 'standard';
    add(
      'furniture',
      [
        f.setup === null && 'Which setup is in place?',
        !f.chairType.trim() && 'Chair type',
        f.chairCount == null && 'Chair count',
        standard && f.tablecloth === null && 'Tablecloth provided?',
        !f.photos.length && 'Photo of the setup',
      ],
      [
        f.setup === 'none' && 'No setup in place yet',
        standard && f.tablecloth === 'no' && 'Standard desks without a tablecloth',
        f.chairCount != null && f.chairCount < pol.gameReadyTarget && `Only ${f.chairCount} chairs`,
      ],
    );
  }

  {
    const todo: string[] = [];
    const game = r.laptops.filter((l) => l.role === 'game');
    if (!r.laptops.length) todo.push('Count the laptops');
    for (const l of game) {
      const missing = [
        ...pol.games.flatMap((g) => [!l.games[g] && `${g} installed`, !l.launched?.[g] && `${g} launched`]),
        !l.drivers && 'drivers',
        !l.windows && 'Windows updates',
        !l.photos.length && 'photo',
      ].filter(Boolean);
      if (missing.length) todo.push(`${l.label}: ${missing.join(', ')}`);
    }
    add('laptops', todo, [
      r.laptops.length > 0 && game.length < pol.gameReadyTarget && `Only ${r.laptops.length} laptop(s) — ${pol.gameReadyTarget} game stations needed`,
      r.laptops.length > 0 && !r.laptops.some((l) => l.role === 'admin') && 'No spare laptop for the admin PC',
    ]);
  }

  {
    const n = r.network;
    const manual = n.speed?.method === 'manual';
    // Only a finite download figure counts as measured — a blank manual entry is not a result.
    const measured = hasDownload(n.speed);
    add(
      'network',
      [
        n.wifi === null && 'Wi-Fi available?',
        n.lan === null && 'LAN available?',
        !measured && (n.speed ? 'Speed result has no download figure — run the test or enter it again' : 'Run the speed test'),
        manual && !n.photos.length && 'Screenshot of the speed result',
      ],
      [
        n.wifi === 'no' && n.lan === 'no' && 'No internet at the venue',
        n.lan === 'no' && n.wifi !== 'no' && 'No LAN — matches will run on Wi-Fi',
        measured && n.speed!.down! < pol.minDownMbps && `Download ${n.speed!.down} Mbps is below the ${pol.minDownMbps} Mbps minimum`,
        manual && 'Speed typed in by hand, not measured by the app',
      ],
    );
  }

  {
    const c = r.collateral;
    add('collateral', [
      !c.posters && 'Posters printed & with you',
      !c.standee && 'Standee placed',
      !c.cheque && 'Prize cheque placed',
      !c.standeePhotos.length && 'Photo of the standee',
      !c.chequePhotos.length && !c.chequeInStandeePhoto && 'Photo of the cheque',
    ]);
  }

  const flags: Record<string, string[]> = {};
  for (const p of reccePhotoRefs(r)) {
    const f = photoFlags(p, store);
    if (f.length) flags[p.id] = f;
  }
  const flagged = Object.keys(flags).length;
  const issues = sections.flatMap((s) => s.issues);
  if (flagged) issues.push(`${flagged} proof photo(s) flagged — see the photo notes`);
  const kind = venueRefKind(store);
  if (kind !== 'hq' && reccePhotoRefs(r).length) issues.push(kind === 'provisional' ? 'Venue location not verified by HQ — photo distances are checked against the first geotagged photo' : 'No venue location — photo locations can’t be checked against the store');

  const done = sections.filter((s) => s.done).length;
  return {
    sections,
    progress: done / sections.length,
    issues,
    photoFlags: flags,
    policy: pol,
    verdict: done < sections.length ? 'incomplete' : issues.length ? 'attention' : 'ready',
  };
}

export const VERDICT_LABEL = { incomplete: 'In progress', attention: 'Ready — with notes', ready: 'Ready to play' } as const;

/** Same, but a report already sent to HQ with gaps reads as such — not "in progress". */
export const verdictLabel = (verdict: Assessment['verdict'], submitted: boolean) => (verdict === 'incomplete' && submitted ? 'Submitted incomplete' : VERDICT_LABEL[verdict]);
