import type { ReactNode } from 'react';
import type { PhotoRef, Store, TournamentEvent } from '../lib/types.ts';
import { assess, verdictLabel } from '../lib/assess.ts';
import { provenanceSummary, type EvidenceBanner } from '../lib/evidence.ts';
import { fmtCoord, mapUrl } from '../lib/geo.ts';
import { readRecce, reccePhotoRefs, storeDate, venueRef, venueRefKind } from '../lib/recce.ts';
import { isMeasure } from '../lib/speedtest.ts';
import { isLegacy, revLabel, submissionPolicy, type AnySubmission } from '../lib/submission.ts';
import { storePrefix, storeShortName } from '../lib/names.ts';
import { cx, fmtDate, fmtDateTime, fmtTime } from '../lib/util.ts';

/** When / how a photo was captured, kept apart from when it reached the app. */
export function photoTimes(p: PhotoRef): string {
  if (p.source === 'upload' || (!p.source && !p.live)) return p.shotAt ? `Shot ${fmtDateTime(p.shotAt)} (from the file) · uploaded ${fmtDateTime(p.takenAt)}` : `Uploaded ${fmtDateTime(p.takenAt)} · no capture time in the file`;
  if (p.live === false) return `Added ${fmtDateTime(p.takenAt)} · the camera returned a file from ${fmtDateTime(p.fileTime)}`;
  return `Captured in the app ${fmtDateTime(p.takenAt)}`;
}

/** Where, and how that was measured. */
export function photoPlace(p: PhotoRef): string {
  if (!p.geo) return 'No location';
  const how = p.geoFrom === 'photo' ? 'from the photo file' : p.geoAt ? `phone GPS at ${fmtTime(p.geoAt)}` : 'phone GPS';
  return `${fmtCoord(p.geo)}${p.geo.accuracy ? ` ±${p.geo.accuracy} m` : ''} · ${how}`;
}

/*
 * The recce report — the pre-event venue check, so no match-day data. Pure render (no hooks) so the same markup can be exported as a
 * standalone HTML file with renderToStaticMarkup.
 *
 * `submission` = the revision shown: its frozen recce, judged against the requirements it was
 * submitted under. Without one it shows the working draft against the current campaign settings.
 * `banner` = evidence missing from this copy — an incomplete export must carry it.
 */
export function Report({
  event,
  store,
  src,
  generatedAt,
  submission,
  banner,
  evidenceNote,
  draftNote,
}: {
  event: TournamentEvent;
  store: Store;
  src: (id: string) => string | undefined;
  generatedAt: string;
  submission?: AnySubmission;
  banner?: EvidenceBanner | null;
  evidenceNote?: string; // e.g. "All 9 proof photos included." — only once verified
  draftNote?: string; // e.g. "Edited since rev 2 — not re-submitted yet"
}) {
  const r = readRecce(submission ? submission.recce : store.recce);
  const a = assess(event, store, { recce: r, policy: submissionPolicy(submission) });
  const games = a.policy.games;
  const game = r.laptops.filter((l) => l.role === 'game');
  const gameReady = game.filter((l) => games.every((g) => l.games[g] && l.launched?.[g]) && l.drivers && l.windows).length;
  const num = (v: number | null | undefined) => (isMeasure(v) ? String(v) : '—');
  const refKind = venueRefKind(store);
  const yn = (v: 'yes' | 'no' | null) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '—');
  const setup = { rog: 'ROG setup', standard: 'Standard desk', none: 'Nothing yet' } as const;
  const ref = venueRef(store);
  const done = (b: boolean) => (b ? 'Yes' : 'No');
  const gameCell = (l: (typeof r.laptops)[number], g: string) => (l.games[g] && l.launched?.[g] ? '✓' : l.games[g] ? 'Installed, not launched' : '✗');

  const prefix = storePrefix(store.name);
  const pin = (
    <>
      <span className="rp-pin-k">Venue pin</span>
      {store.mapsUrl && /^https?:\/\//i.test(store.mapsUrl) ? <a href={store.mapsUrl}>{ref ? fmtCoord(ref) : 'Open in Maps'}</a> : ref ? <a href={mapUrl(ref)}>{fmtCoord(ref)}</a> : '—'}
      <small className="ev-sub">{refKind === 'hq' ? 'From HQ’s Maps link' : refKind === 'provisional' ? 'Provisional — from the first geotagged photo, not verified by HQ' : 'Not set — photo locations can’t be checked'}</small>
    </>
  );
  const flagged = reccePhotoRefs(r).filter((p) => a.photoFlags[p.id]);

  // Just the label under each photo: when and where it was taken is burned into the picture itself (and the hover title); only problems are listed, once, at the end.
  const photoGrid = (list: PhotoRef[], solo?: boolean) =>
    list.length ? (
      <div className={cx('rp-photos', solo && 'solo', solo && list.length > 1 && 'multi')}>
        {list.map((p) => (
          <figure key={p.id}>
            {src(p.id) ? <img src={src(p.id)} alt={p.label} title={`${photoTimes(p)} · ${photoPlace(p)}`} data-photo-id={p.id} /> : <div className="ph ev-ph">{banner ? 'Photo missing from this copy' : 'Photo not loaded yet'}</div>}
            {p.label && <figcaption>{p.label}</figcaption>}
          </figure>
        ))}
      </div>
    ) : (
      <p className="rp-none">No photos.</p>
    );

  const block = ({ n, title, rows, photos, extra, cls, solo }: { n: string; title: string; rows: [string, ReactNode][]; photos?: PhotoRef[]; extra?: ReactNode; cls?: string; solo?: boolean }) => (
    <section className={cx('rp-sec', cls)}>
      <header>
        <span className="rp-n">{n}</span>
        <h2>{title}</h2>
        <span className={cx('rp-state', a.sections.find((s) => s.title === title)?.done && 'done')}>{a.sections.find((s) => s.title === title)?.done ? 'Complete' : 'Incomplete'}</span>
      </header>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className={typeof v === 'string' && v.length > 30 ? 'wide' : undefined}>
            <dt>{k}</dt>
            <dd>{v || '—'}</dd>
          </div>
        ))}
      </dl>
      {extra}
      {photos && photoGrid(photos, solo)}
    </section>
  );


  return (
    <article className="report">
      {banner && (
        <section className="ev-banner" role="alert">
          <strong>{banner.title}</strong>
          <ul>
            {banner.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      )}
      {draftNote && <p className="ev-draft">{draftNote}</p>}
      <header className="rp-mast">
        <div className="rp-kicker">
          <span>Store recce report</span>
          <span>{[event.name, prefix].filter(Boolean).join(' · ')}</span>
        </div>
        <h1>{storeShortName(store.name)}</h1>
        <div className="rp-where">
          <p className="rp-addr">{store.address || 'Address not set'}</p>
          <div className="rp-pin">{pin}</div>
        </div>
        <p className="rp-meta">
          {[
            fmtDate(storeDate(store, event)),
            store.city,
            store.admin && `Admin ${store.admin}`,
            submission ? (isLegacy(submission) ? `Submitted ${fmtDateTime(submission.submittedAt)}` : `${revLabel(submission).replace(/^rev/, 'Rev')} · submitted ${fmtDateTime(submission.submittedAt)}${submission.byName ? ` by ${submission.byName}` : ''}`) : 'Working draft',
            submission && !isLegacy(submission) && (submission.reviewedAt ? `Recce approved ✓ ${fmtDate(submission.reviewedAt)}${submission.reviewedBy ? ` by ${submission.reviewedBy}` : ''}` : 'Not approved yet'),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div className={cx('rp-verdict', a.verdict)}>
          <div className="rp-verdict-word">{verdictLabel(a.verdict, !!submission)}</div>
          <div className="rp-stats">
            <div>
              <strong>
                {gameReady}
                <small>/{a.policy.gameReadyTarget}</small>
              </strong>
              <span>Laptops game-ready</span>
            </div>
            <div>
              <strong>
                {num(r.network.speed?.down)}
                <small> Mbps</small>
              </strong>
              <span>Download</span>
            </div>
            <div>
              <strong>{yn(r.network.lan)}</strong>
              <span>LAN</span>
            </div>
            <div>
              <strong>{r.furniture.setup ? setup[r.furniture.setup] : '—'}</strong>
              <span>Setup</span>
            </div>
          </div>
        </div>
        {(a.issues.length > 0 || a.sections.some((s) => !s.done)) && (
          <ul className="rp-issues">
            {a.sections
              .filter((s) => !s.done)
              .map((s) => (
                <li key={s.key}>
                  <b>{s.title}</b> incomplete — {s.todo.join('; ')}
                </li>
              ))}
            {a.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </header>

      <div className="rp-pair">
        {block({ n: '01', title: 'Venue', cls: 'rp-venue', solo: true, rows: [['Venue spot', store.venue ?? ''], ...(r.venue.area ? [['Admin’s notes', r.venue.area] as [string, string]] : [])], photos: r.venue.photos })}

        {block({
          n: '02',
          title: 'Setup',
          cls: 'rp-setup',
          solo: true,
          rows: [
            ['Setup', r.furniture.setup ? setup[r.furniture.setup] : ''],
            ['Chairs', r.furniture.chairCount != null ? `${r.furniture.chairCount} × ${r.furniture.chairType || 'chairs'}` : r.furniture.chairType],
            ...(r.furniture.setup === 'standard' ? [['Tablecloth', yn(r.furniture.tablecloth)] as [string, string]] : []),
          ],
          photos: r.furniture.photos,
        })}
      </div>

      {block({
        n: '03',
        title: 'Laptops',
        cls: 'rp-laptops',
        rows: [
          ['At the store', String(r.laptops.length)],
          ['Game stations', `${gameReady} of ${game.length} fully ready`],
          ['Admin PC', r.laptops.find((l) => l.role === 'admin')?.label ?? 'None'],
          ['Games', games.join(', ')],
        ],
        extra: (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Laptop</th>
                <th>Role</th>
                {games.map((g) => (
                  <th key={g}>{g}</th>
                ))}
                <th>Drivers</th>
                <th>Windows</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {r.laptops.map((l) => (
                <tr key={l.id}>
                  <td>{l.label}</td>
                  <td>{l.role === 'game' ? 'Game' : l.role === 'admin' ? 'Admin' : 'Spare'}</td>
                  {games.map((g) => (
                    <td key={g}>{l.role === 'game' ? gameCell(l, g) : ''}</td>
                  ))}
                  <td>{l.role === 'game' ? (l.drivers ? '✓' : '✗') : ''}</td>
                  <td>{l.role === 'game' ? (l.windows ? '✓' : '✗') : ''}</td>
                  <td>{l.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ),
        photos: r.laptops.flatMap((l) => l.photos),
      })}

      {block({
        n: '04',
        title: 'Internet',
        rows: [
          ['Wi-Fi', yn(r.network.wifi)],
          ['LAN', yn(r.network.lan)],
          [
            'Speed',
            r.network.speed
              ? `${num(r.network.speed.down)} down / ${num(r.network.speed.up)} up Mbps · ${num(r.network.speed.ping)} ms ping`
              : '',
          ],
          ['Measured', r.network.speed ? `${r.network.speed.method === 'auto' ? 'In-app test' : 'Entered by hand'}, ${fmtDateTime(r.network.speed.at)}` : ''],
        ],
        photos: r.network.photos,
      })}

      {block({
        n: '05',
        title: 'Collateral',
        rows: [
          ['Posters printed', done(r.collateral.posters)],
          ['Standee placed', done(r.collateral.standee)],
          ['Prize cheque placed', done(r.collateral.cheque) + (r.collateral.chequeInStandeePhoto ? ' · shown in the standee photo' : '')],
        ],
        photos: [...r.collateral.standeePhotos, ...r.collateral.chequePhotos],
      })}

      {r.summary && (
        <section className="rp-sec rp-notes">
          <header>
            <h2>Notes</h2>
          </header>
          <p>{r.summary}</p>
          <cite>— {store.admin || 'Admin'}, on site</cite>
        </section>
      )}

      {flagged.length > 0 && (
        <section className="rp-sec rp-pnotes">
          <header>
            <h2>Photo notes</h2>
            <span className="rp-state">{flagged.length} flagged</span>
          </header>
          <ul>
            {flagged.map((p) => (
              <li key={p.id}>
                <b>{p.label || 'Photo'}</b> — {a.photoFlags[p.id].join('; ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="rp-foot">
        <span>
          Generated {fmtDateTime(generatedAt)}
          {submission ? ` · ${isLegacy(submission) ? 'submitted report' : revLabel(submission)}, judged against the requirements it was submitted under` : ' · working draft, judged against the current campaign settings'}
        </span>
        <span>
          {provenanceSummary(reccePhotoRefs(r))}
          {evidenceNote ? ` ${evidenceNote}` : ''}
        </span>
      </footer>
    </article>
  );
}
