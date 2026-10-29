import { useRef, useState } from 'react';
import { copiesText, dispositionName, driveThumb, fileShareText, specLine, type PrintRow } from '../lib/printShare.ts';
import { cx, fmtTime } from '../lib/util.ts';
import { toast } from './ui.tsx';
import '../styles/print.css';

/*
 * Print files — the pieces both screens share: a file's thumbnail in its true shape and the card with
 * Save / Share. The store team's page (signed in) and the print desk's page (a public link) differ only
 * in the addresses they pass in; nothing here reads the app's state, so the public page can use it.
 */

/** A file as a card shows it. `link` is the Drive page that can be sent instead of the file. */
export interface PrintItem extends PrintRow {
  driveId: string;
  link: string;
}

/** Opens the share sheet, or WhatsApp's own link where a browser has none (a desktop). */
export async function shareText(text: string): Promise<boolean> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return true;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return false; // they closed the sheet
    }
  }
  const w = window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  if (!w) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied — paste it into WhatsApp');
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/** The Drive thumbnail, kept in its own shape (a standee is not a cheque) and never cropped. */
export function PrintThumb({ driveId, alt, href, width = 400 }: { driveId: string; alt: string; href?: string; width?: number }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');
  const r = Math.min(2.2, Math.max(0.45, ratio ?? 1.3));
  const inner = (
    <div className={cx('pf-thumb', state === 'loading' && 'fd-shimmer', state === 'failed' && 'failed')} style={{ aspectRatio: state === 'failed' ? '2.4' : String(r) }}>
      {state === 'failed' ? (
        <span>No preview</span>
      ) : (
        <img
          src={driveThumb(driveId, width)}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={(e) => {
            const i = e.currentTarget;
            if (i.naturalWidth && i.naturalHeight) setRatio(i.naturalWidth / i.naturalHeight);
            setState('ok');
          }}
          onError={() => setState('failed')}
        />
      )}
    </div>
  );
  return href ? (
    <a className="pf-thumb-link" href={href} target="_blank" rel="noreferrer" aria-label={`Open ${alt} full size`}>
      {inner}
    </a>
  ) : (
    inner
  );
}

/**
 * One file: thumbnail, what it is, how to print it, and the two ways to get it onto a phone.
 * "Save" is a plain link to the server's file route, so the browser names the download itself;
 * "Share" fetches the file and hands the real file to the phone's share sheet (WhatsApp as a
 * Document, AirDrop, Drive…), falling back to the Drive link where files can't be shared.
 */
export function PrintFileCard({
  item,
  storeName,
  saveHref,
  viewHref,
  variant,
  saveLabel = 'Save to phone',
  saved,
  index,
  onGot,
}: {
  item: PrintItem;
  storeName: string;
  saveHref: string;
  viewHref?: string;
  variant: 'big' | 'slim';
  saveLabel?: string;
  saved?: { at: string; by: string };
  index?: number; // position in a staggered list
  onGot?: () => void; // called when the file was saved or shared — the store team's page records it
}) {
  const file = useRef<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false); // the file is fetched; the next tap shares at once

  const share = async () => {
    if (busy) return;
    const text = fileShareText(item, storeName);
    const link = () => shareText(`${text}\n${item.link}`).then((sent) => sent && onGot?.());
    const canFiles = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
    if (!canFiles) return void link();
    setBusy(true);
    try {
      let f = file.current;
      if (!f) {
        const res = await fetch(saveHref, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const name = dispositionName(res.headers.get('content-disposition')) || `${item.label}.${/pdf/i.test(blob.type) ? 'pdf' : 'jpg'}`;
        f = new File([blob], name, { type: blob.type || 'application/octet-stream' });
        if (!navigator.canShare({ files: [f] })) return void (await link());
        file.current = f;
      }
      await navigator.share({ files: [f], text });
      setReady(false);
      onGot?.();
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'AbortError') return; // closed the sheet
      if (name === 'NotAllowedError' && file.current) {
        // The download took long enough that the browser wants a fresh tap; the file is ready now.
        setReady(true);
        toast(`${item.label} is ready — tap Share again`, { tone: 'accent' });
      } else {
        toast('Couldn’t share the file — sending the link instead', { tone: 'warn' });
        await link();
      }
    } finally {
      setBusy(false);
    }
  };

  const got = () => {
    toast(`Saving ${item.label}…`);
    onGot?.();
  };

  return (
    <li className={cx('pf', variant, saved && 'saved')} style={index === undefined ? undefined : { ['--i' as string]: index }}>
      <PrintThumb driveId={item.driveId} alt={item.label} href={viewHref} width={variant === 'slim' ? 240 : 480} />
      <div className="pf-body">
        <h3 className="pf-label">{item.label}</h3>
        <p className="pf-spec" title={`${item.size} · ${copiesText(item.kind, item.qty)}`}>
          {specLine(item)}
        </p>
        {saved && (
          <p className="pf-saved">
            <span aria-hidden>✓</span> Saved · {fmtTime(saved.at)} · {saved.by}
          </p>
        )}
        <div className="pf-actions">
          <a className="btn accent" href={saveHref} download onClick={got}>
            {saveLabel}
          </a>
          <button className={cx('btn', ready ? 'accent' : 'ghost')} type="button" onClick={share} disabled={busy} aria-busy={busy}>
            {busy ? 'Getting it…' : ready ? 'Share now' : 'Share'}
          </button>
        </div>
      </div>
    </li>
  );
}
