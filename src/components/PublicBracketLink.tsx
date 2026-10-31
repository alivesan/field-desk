import { useState } from 'react';
import { updateStore } from '../lib/db.ts';
import { shareOrigin, useLan } from '../lib/origin.ts';
import { publicBracketUrl, rotatePublicBracket, turnOffPublicBracket, turnOnPublicBracket } from '../lib/publicBracket.ts';
import type { Store } from '../lib/types.ts';
import { cx } from '../lib/util.ts';
import { CheckInQr } from './CheckInQr.tsx';
import { askConfirm, Chip, notify, toast } from './ui.tsx';
import '../styles/checkin.css';
import '../styles/public-bracket.css';

/**
 * HQ: the store's public bracket link (Store.publicBracket) — players and anyone at the venue follow the bracket
 * live on /b/<token>, no sign-in, names and results only. Turn it on (the first time makes the link), copy it or
 * show its QR, make a new link (the old one stops working at once) or turn it off.
 */
export function PublicBracketLink({ store }: { store: Store }) {
  useLan(); // the PC's Wi-Fi address, once known, replaces "localhost" in the link
  const [copied, setCopied] = useState(false);
  const pb = store.publicBracket;
  const on = !!pb?.on;
  const url = pb ? publicBracketUrl(shareOrigin(), pb.token) : '';

  const toggle = () => updateStore(store.id, (s) => (on ? turnOffPublicBracket(s) : turnOnPublicBracket(s, new Date().toISOString())));
  const rotate = async () =>
    (await askConfirm('Make a new link? The old link and QR stop working at once, so anyone who has them sees that it isn’t public.', { ok: 'New link', danger: true })) &&
    updateStore(store.id, (s) => rotatePublicBracket(s, new Date().toISOString()));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast('Link copied');
    } catch {
      void notify(`Copy this link: ${url}`);
    }
  };

  return (
    <section className="pbl" aria-labelledby="pbl-h">
      <div>
        <h2 id="pbl-h">
          Public bracket
          <Chip tone={on ? 'ok' : 'muted'}>{on ? 'On' : 'Off'}</Chip>
        </h2>
        <p className="hint">
          {on
            ? 'Anyone with this link or QR follows the bracket live, with no sign-in — names, in-game names, results and stations. Never phones or check-ins.'
            : 'A live bracket page for players and the venue: results as they happen, on a phone or a TV. Names only, no sign-in.'}
        </p>
        {on && (
          <span className="pbl-url" title={url}>
            {url.replace(/^https?:\/\//, '')}
          </span>
        )}
        <div className="pbl-actions">
          <button className={cx('btn', on && 'ghost')} onClick={toggle}>
            {on ? 'Turn off' : 'Turn on'}
          </button>
          {on && (
            <button className="btn" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          )}
          {on && (
            <a className="link" href={url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          {pb && (
            <button className="link" onClick={rotate}>
              New link
            </button>
          )}
        </div>
      </div>
      {on && (
        <div className="pbl-qr">
          <CheckInQr value={url} title="QR code for the public bracket" />
          <span className="label">Scan to follow</span>
        </div>
      )}
    </section>
  );
}
