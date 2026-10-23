import { useState } from 'react';
import type { Admin, GeoFix, Store } from '../lib/types.ts';
import { coordsFromMapsUrl, isShortMapsLink, mapsUrlProblem } from '../lib/recce.ts';
import { fmtCoord } from '../lib/geo.ts';
import { toornamentLinkProblem } from '../lib/toornament.ts';
import { Check, Field } from './ui.tsx';

export interface StoreDetails {
  name: string;
  city: string;
  state: string;
  exclusive: boolean; // an ASUS ROG Exclusive store
  date: string;
  phone: string;
  address: string;
  mapsUrl: string;
  venue: string;
  adminId: string;
  geo: GeoFix | null;
  toornamentUrl: string; // HQ-only; saved with applyToornamentLink (src/lib/toornament.ts)
}

export const detailsOf = (s: Store | undefined, campaignDate: string): StoreDetails => ({
  name: s?.name ?? '',
  city: s?.city ?? '',
  state: s?.state ?? '',
  exclusive: !!s?.exclusive,
  date: s?.date || campaignDate,
  phone: s?.phone ?? '',
  address: s?.address ?? '',
  mapsUrl: s?.mapsUrl ?? '',
  venue: s?.venue ?? '',
  adminId: s?.adminId ?? '',
  geo: s?.geo ?? null,
  toornamentUrl: s?.toornament?.url ?? '',
});

/** Venue coordinates from a Maps link; short links are expanded by the server first. Never throws. */
export async function locate(url: string): Promise<GeoFix | null> {
  if (!url.trim() || mapsUrlProblem(url)) return null;
  const direct = coordsFromMapsUrl(url);
  if (direct || !isShortMapsLink(url)) return direct;
  try {
    const r = await fetch(`/api/resolve-map?url=${encodeURIComponent(url.trim())}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { url?: unknown };
    return typeof body?.url === 'string' ? coordsFromMapsUrl(body.url) : null;
  } catch {
    return null;
  }
}

/** HQ's store details: everything the admin should not have to type. */
export function StoreForm({ initial, admins, submitLabel, onSave, onCancel }: { initial: StoreDetails; admins: Admin[]; submitLabel: string; onSave: (d: StoreDetails) => void; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [geoNote, setGeoNote] = useState(initial.geo ? `📍 ${fmtCoord(initial.geo)} — the reference for photo distance checks` : '');
  const [mapsError, setMapsError] = useState('');
  // A link without coordinates is allowed, but only after HQ has seen that it can't be used as the reference.
  const [noGeoOk, setNoGeoOk] = useState(false);
  const [toornamentError, setToornamentError] = useState('');
  const set = (k: keyof StoreDetails, v: string | boolean) => setD({ ...d, [k]: v });

  const save = async () => {
    const problem = mapsUrlProblem(d.mapsUrl);
    if (problem) return setMapsError(problem);
    const tProblem = toornamentLinkProblem(d.toornamentUrl);
    if (tProblem) return setToornamentError(tProblem);
    setBusy(true);
    let geo: GeoFix | null = null;
    try {
      geo = d.mapsUrl === initial.mapsUrl && initial.geo ? initial.geo : await locate(d.mapsUrl);
    } catch {
      geo = null; // locate shouldn't throw; never leave the button stuck if it does
    } finally {
      setBusy(false);
    }
    if (d.mapsUrl.trim() && !geo && !noGeoOk) {
      setMapsError('No coordinates in that link — open the place in Google Maps and copy the link from Share. Or save without: the first geotagged venue photo will set a provisional location that isn’t HQ-verified.');
      setNoGeoOk(true);
      return;
    }
    onSave({ ...d, name: d.name.trim(), state: d.state.trim(), mapsUrl: d.mapsUrl.trim(), toornamentUrl: d.toornamentUrl.trim(), geo });
  };

  return (
    <div className="card form">
      <div className="grid2">
        <Field label="Store name" value={d.name} onChange={(v) => set('name', v)} />
        <Field label="City" value={d.city} onChange={(v) => set('city', v)} />
      </div>
      <div className="grid2">
        <Field label="State" value={d.state} onChange={(v) => set('state', v)} />
        <div className="field">
          <span className="label">Store type</span>
          <Check checked={d.exclusive} onChange={(v) => set('exclusive', v)}>
            ROG Exclusive store
          </Check>
        </div>
      </div>
      <div className="grid2">
        <Field label="Tournament day" type="date" value={d.date} onChange={(v) => set('date', v)} />
        <Field label="Store phone" type="tel" value={d.phone} onChange={(v) => set('phone', v)} />
      </div>
      <Field label="Address" value={d.address} onChange={(v) => set('address', v)} />
      <Field
        label="Google Maps link"
        value={d.mapsUrl}
        placeholder="https://maps.app.goo.gl/…"
        onChange={(v) => {
          set('mapsUrl', v);
          setGeoNote('');
          setMapsError('');
          setNoGeoOk(false);
        }}
      />
      {mapsError ? <p className="field-error">{mapsError}</p> : geoNote && <p className="hint">{geoNote}</p>}
      <Field label="Venue spot in the store" value={d.venue} placeholder="e.g. Ground floor, ROG zone next to the display wall" onChange={(v) => set('venue', v)} />
      <Field
        label="Toornament link (optional)"
        value={d.toornamentUrl}
        placeholder="https://play.toornament.com/en_US/tournaments/…/"
        onChange={(v) => {
          set('toornamentUrl', v);
          setToornamentError('');
        }}
      />
      {toornamentError ? (
        <p className="field-error">{toornamentError}</p>
      ) : (
        <p className="hint">This store’s bracket on Toornament — open the tournament there and copy the address (a stage page works too). Players &amp; bracket can then fetch it from there.</p>
      )}
      <div className="field">
        <span className="label">Admin</span>
        <select className={'assign' + (d.adminId ? '' : ' none')} value={d.adminId} onChange={(e) => set('adminId', e.target.value)}>
          <option value="">{admins.length ? 'Assign an admin…' : 'No admins yet — add them in Team'}</option>
          {admins.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.code}
            </option>
          ))}
        </select>
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn accent" disabled={!d.name.trim() || busy} onClick={save}>
          {busy ? 'Finding the location…' : noGeoOk && mapsError ? `${submitLabel} without location` : submitLabel}
        </button>
      </div>
    </div>
  );
}
