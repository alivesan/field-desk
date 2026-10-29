import { useEffect, useState } from 'react';
import { update } from '../lib/db.ts';
import { PRINT_DEFAULTS, PRINT_KINDS } from '../lib/print.ts';
import { printRow } from '../lib/printRow.ts';
import type { PrintKind, TournamentEvent } from '../lib/types.ts';
import '../styles/print.css';

/**
 * HQ: the print instructions every store sees on its cards — size and copies per file. They start as
 * the defaults (PRINT_DEFAULTS); a change is kept on the campaign (event.printSpec) and a row that
 * matches the default again is simply forgotten.
 */
export function PrintSpecs({ event }: { event: TournamentEvent }) {
  return (
    <div className="ps">
      <div className="ps-head label" aria-hidden>
        <span>File</span>
        <span>Print size</span>
        <span>Copies</span>
      </div>
      {PRINT_KINDS.map((kind) => (
        <SpecRow key={kind} event={event} kind={kind} />
      ))}
      <p className="hint">Shown on every store’s cards, the print desk and the “Send to print shop” message. Changes apply to files already added.</p>
    </div>
  );
}

function SpecRow({ event, kind }: { event: TournamentEvent; kind: PrintKind }) {
  const row = printRow(event, kind);
  const def = PRINT_DEFAULTS[kind];
  const [size, setSize] = useState(row.size);
  const [qty, setQty] = useState(String(row.qty));
  // Follow changes from elsewhere (another HQ device) while nobody is typing here.
  useEffect(() => {
    setSize(row.size);
    setQty(String(row.qty));
  }, [row.size, row.qty]);

  const commit = (nextSize: string, nextQty: number) =>
    update((d) => {
      const e = d.events[event.id];
      if (!e) return;
      if (nextSize === def.size && nextQty === def.qty) {
        if (e.printSpec) delete e.printSpec[kind];
        if (e.printSpec && !Object.keys(e.printSpec).length) delete e.printSpec;
      } else (e.printSpec ??= {})[kind] = { size: nextSize, qty: nextQty };
    });
  const blur = () => {
    const n = Math.round(Number(qty));
    const s = size.trim().slice(0, 60) || def.size;
    const q = Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : row.qty;
    setSize(s);
    setQty(String(q));
    if (s !== row.size || q !== row.qty) commit(s, q);
  };

  const custom = row.size !== def.size || row.qty !== def.qty;
  return (
    <div className="ps-row">
      <b className="ps-label">{def.label}</b>
      <label className="ps-field">
        <span className="sr-only">{def.label} print size</span>
        <input value={size} maxLength={60} placeholder={def.size} onChange={(e) => setSize(e.target.value)} onBlur={blur} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </label>
      <label className="ps-field qty">
        <span className="sr-only">{def.label} copies</span>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 6))} onBlur={blur} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </label>
      {custom && (
        <button className="link ps-reset" onClick={() => commit(def.size, def.qty)} title={`Back to ${def.size} · ${def.qty}`}>
          Reset
        </button>
      )}
    </div>
  );
}
