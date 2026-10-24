import { useEffect, useRef, useState } from 'react';
import type { GeoFix, PhotoRef, Store } from '../lib/types.ts';
import { deletePhoto, getState, savePhoto, updateStore, usePhotoUrls } from '../lib/db.ts';
import { fmtCoord, freshFix, getFix, getTimedFix, type TimedFix } from '../lib/geo.ts';
import { allEvidenceRefs } from '../lib/recce.ts';
import { readExif } from '../lib/exif.ts';
import { stampPhoto } from '../lib/stamp.ts';
import { photoFlags } from '../lib/assess.ts';
import { cx, fmtDateTime, fmtTime, uid } from '../lib/util.ts';
import { askConfirm, notify } from './ui.tsx';

/** A photo taken this long before it reaches the app still counts as live (camera handoff can be slow). */
const LIVE_WINDOW_MS = 5 * 60 * 1000;
/** A fix coarser than this doesn't become the store's provisional venue pin. */
const POOR_FIX_FOR_PIN_M = 100;

/**
 * One required proof photo. Needed: a ring + one-tap camera button. Done: folds into a
 * single row ("✓ 2 photos · GPS"), tap to open the photos.
 *
 * "Take photo" opens the rear camera and stamps the phone's GPS, measured when the photo
 * comes back (a fix warmed up while the camera was open is reused only if it is under a
 * minute old). "Upload" takes a photo from the gallery — e.g. from a GPS-camera app — and
 * uses the time / GPS saved inside the file, if the phone kept it.
 *
 * `update` applies a change to the slot's photo list as it is in the current state (never a
 * copy captured before the async stamping), so a photo added meanwhile on another device survives.
 */
export function PhotoSlot({
  store,
  label,
  hint,
  photos,
  update,
  optional,
}: {
  store: Store;
  label: string;
  hint?: string;
  photos: PhotoRef[];
  update: (fn: (photos: PhotoRef[]) => void) => void;
  optional?: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const fix = useRef<Promise<TimedFix | Error> | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PhotoRef | null>(null);
  const urls = usePhotoUrls(photos.map((p) => p.id));
  const flagged = photos.filter((p) => photoFlags(p, store).length).length;
  const done = photos.length > 0;
  // A photo arriving gives the slot's tick a gentle pop (a remount of the dot restarts the animation).
  const had = useRef(photos.length);
  const [pops, setPops] = useState(0);
  useEffect(() => {
    if (photos.length > had.current) setPops((n) => n + 1);
    had.current = photos.length;
  }, [photos.length]);

  const takePhoto = () => {
    fix.current = getTimedFix().catch((e: Error) => e); // warm up GPS while the camera is open
    camera.current?.click();
  };

  const onFile = async (file: File | undefined, source: 'camera' | 'upload') => {
    if (!file) return;
    setBusy(true);
    try {
      const now = new Date();
      const lm = file.lastModified || now.getTime();
      const exif = await readExif(file);
      let geo: GeoFix | null = null;
      let geoError: string | undefined;
      let geoFrom: PhotoRef['geoFrom'];
      let geoAt: string | undefined;
      if (source === 'camera') {
        // The location must describe where the photo came back, not where the camera was opened.
        const warm = fix.current ? await fix.current : null;
        fix.current = null;
        let got: TimedFix | Error | null = freshFix(warm, Date.now());
        if (!got) got = await getTimedFix(15000, 10000).catch((e: Error) => e);
        if (got instanceof Error) geoError = got.message;
        else [geo, geoFrom, geoAt] = [got.fix, 'device', got.at];
      } else if (exif.geo) [geo, geoFrom] = [exif.geo, 'photo'];

      const ref: PhotoRef = {
        id: uid(),
        label,
        takenAt: now.toISOString(),
        fileTime: new Date(lm).toISOString(),
        live: source === 'camera' && Math.abs(now.getTime() - lm) < LIVE_WINDOW_MS,
        source,
        shotAt: exif.shotAt,
        geo,
        geoFrom,
        geoAt,
        geoError,
      };
      const time = source === 'camera' ? (ref.live ? fmtDateTime(ref.takenAt) : `ADDED ${fmtDateTime(ref.takenAt)} · FILE FROM ${fmtDateTime(ref.fileTime)}`) : ref.shotAt ? `SHOT ${fmtDateTime(ref.shotAt)}` : `UPLOADED ${fmtDateTime(ref.takenAt)} · NO CAPTURE TIME`;
      const place = geo
        ? `${fmtCoord(geo)}${geo.accuracy ? `  ±${geo.accuracy} m` : ''}${geoFrom === 'photo' ? '  (FROM PHOTO)' : ''}`
        : source === 'upload'
          ? 'NO GPS IN FILE — SEE THE PHOTO’S OWN STAMP'
          : `LOCATION UNAVAILABLE — ${geoError ?? 'unknown'}`;
      const blob = await stampPhoto(file, { title: store.name, label, time, place, ref: ref.id.slice(0, 6) });
      await savePhoto(ref.id, blob, store.id);
      update((list) => {
        if (!list.some((x) => x.id === ref.id)) list.push(ref);
      });
      // No HQ location yet: the first device-geotagged photo becomes a provisional pin (see venueRefKind).
      if (geo && geoFrom === 'device' && geo.accuracy <= POOR_FIX_FOR_PIN_M) {
        const g = geo;
        updateStore(store.id, (s) => {
          if (!s.pin && !s.geo) s.pin = g;
        });
      }
    } catch (e) {
      void notify(`Couldn’t save that photo: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (camera.current) camera.current.value = '';
      if (gallery.current) gallery.current.value = '';
    }
  };

  const remove = async (p: PhotoRef) => {
    if (!(await askConfirm('Remove this photo?', { ok: 'Remove', danger: true }))) return;
    update((list) => {
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list.splice(i, 1);
    });
    setView(null);
    // Keep the local copy while a submitted revision still shows it (it may not have uploaded yet).
    const cur = getState().stores[store.id];
    if (!cur || !allEvidenceRefs(cur).some((x) => x.id === p.id)) await deletePhoto(p.id);
  };

  const summary = done
    ? [`${photos.length} photo${photos.length > 1 ? 's' : ''}`, fmtTime(photos[photos.length - 1].shotAt ?? photos[photos.length - 1].takenAt), flagged ? `⚑ ${flagged} to check` : photos.every((p) => p.geo) ? 'GPS ✓' : 'no GPS'].join(' · ')
    : (hint ?? (optional ? 'Optional' : 'Photo needed'));

  return (
    <div className={cx('slot', done ? 'done' : optional ? 'optional' : 'needed', open && 'open', flagged > 0 && 'flagged')}>
      <div className="slot-row">
        <button type="button" className="slot-main" onClick={() => done && setOpen((o) => !o)} aria-expanded={done ? open : undefined} disabled={!done}>
          <span key={pops} className={cx('slot-dot', pops > 0 && 'fd-pop')} aria-hidden />
          <span className="slot-text">
            <strong>{label}</strong>
            <small>{summary}</small>
          </span>
          {done && (
            <span className="slot-peek" aria-hidden>
              {photos.slice(-3).map((p) => (urls[p.id] ? <img key={p.id} src={urls[p.id]} alt="" /> : <i key={p.id} />))}
            </span>
          )}
          {done && <span className="slot-chev" aria-hidden />}
        </button>
        {!done && (
          <button type="button" className="btn slot-cta" onClick={takePhoto} disabled={busy}>
            {busy ? 'Stamping…' : 'Take photo'}
          </button>
        )}
      </div>

      {!done && !busy && (
        <button type="button" className="slot-alt" onClick={() => gallery.current?.click()}>
          or upload from your GPS camera app
        </button>
      )}

      {open && done && (
        <div className="slot-body">
          <div className="slot-grid">
            {photos.map((p) => {
              const flags = photoFlags(p, store);
              return (
                <button key={p.id} type="button" className="slot-thumb" onClick={() => setView(p)}>
                  {urls[p.id] ? <img src={urls[p.id]} alt={p.label} /> : <span className="ph" />}
                  <span className={cx('slot-meta', flags.length ? 'warn' : 'ok')}>{flags.length ? `⚑ ${flags.length}` : p.geo ? 'GPS ✓' : '—'}</span>
                </button>
              );
            })}
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={takePhoto} disabled={busy}>
              {busy ? 'Stamping…' : 'Take another'}
            </button>
            <button type="button" className="link" onClick={() => gallery.current?.click()} disabled={busy}>
              Upload from GPS camera app
            </button>
          </div>
        </div>
      )}

      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0], 'camera')} />
      <input ref={gallery} type="file" accept="image/jpeg,image/*" hidden onChange={(e) => onFile(e.target.files?.[0], 'upload')} />

      {view && (
        <div className="lightbox" onClick={() => setView(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            {urls[view.id] && <img src={urls[view.id]} alt={view.label} />}
            <figcaption>
              <div>
                <strong>{view.label}</strong>
                <div className="hint">{view.source === 'upload' ? `Uploaded from gallery ${fmtDateTime(view.takenAt)}${view.shotAt ? ` · shot ${fmtDateTime(view.shotAt)}` : ''}` : `Taken in the app ${fmtDateTime(view.takenAt)}`}</div>
                {view.geo && (
                  <div className="hint">
                    {fmtCoord(view.geo)}
                    {view.geo.accuracy ? ` ±${view.geo.accuracy} m` : ''}
                    {view.geoFrom === 'photo' ? ' · from the photo file' : view.geoAt ? ` · measured ${fmtTime(view.geoAt)}` : ''}
                  </div>
                )}
                {photoFlags(view, store).map((f) => (
                  <div key={f} className="warn">
                    ⚑ {f}
                  </div>
                ))}
              </div>
              <div className="row">
                <button className="btn ghost" onClick={() => remove(view)}>
                  Remove
                </button>
                <button className="btn" onClick={() => setView(null)}>
                  Close
                </button>
              </div>
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}

type LocState = 'checking' | 'granted' | 'prompt' | 'denied' | 'insecure' | 'unsupported';

/** Up-front check: is location on? If not, say exactly how to fix it — or to use a GPS camera app. */
export function LocationCheck() {
  const [state, setState] = useState<LocState>('checking');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!window.isSecureContext) return setState('insecure');
    if (!('geolocation' in navigator)) return setState('unsupported');
    let status: PermissionStatus | null = null;
    navigator.permissions
      ?.query({ name: 'geolocation' })
      .then((s) => {
        status = s;
        setState(s.state as LocState);
        s.onchange = () => setState(s.state as LocState);
      })
      .catch(() => setState('prompt'));
    if (!navigator.permissions) setState('prompt');
    return () => {
      if (status) status.onchange = null;
    };
  }, []);

  const ask = async () => {
    setAsking(true);
    try {
      await getFix();
      setState('granted');
    } catch (e) {
      setState((e as Error).message.includes('denied') ? 'denied' : 'prompt');
    } finally {
      setAsking(false);
    }
  };

  if (state === 'granted' || state === 'checking') return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className={cx('loc', state === 'denied' && 'off')}>
      <strong>{state === 'prompt' ? 'Turn on location for photo proof' : 'Location is off — photos won’t be geotagged'}</strong>
      {state === 'prompt' && <p>Photos are stamped with where they were taken. Allow it once and you’re set.</p>}
      {state === 'denied' && (
        <p>
          {ios ? 'iPhone: Settings → Privacy & Security → Location Services → Safari Websites → While Using.' : 'Android: tap the icon left of the address bar → Permissions → Location → Allow.'} Then reload this page. Or take photos with your GPS camera app and use “upload”.
        </p>
      )}
      {state === 'insecure' && <p>This page isn’t on HTTPS, so the phone won’t share location. Use your GPS camera app and “upload” for now.</p>}
      {state === 'unsupported' && <p>This browser can’t share location. Use your GPS camera app and “upload”.</p>}
      {state === 'prompt' && (
        <button className="btn" onClick={ask} disabled={asking}>
          {asking ? 'Waiting for permission…' : 'Allow location'}
        </button>
      )}
    </div>
  );
}
