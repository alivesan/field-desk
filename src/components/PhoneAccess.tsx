import { useState } from 'react';
import { useLan } from '../lib/origin.ts';
import { CheckInQr } from './CheckInQr.tsx';
import '../styles/phone.css';

/**
 * HQ on the PC at localhost: the address phones on the same Wi-Fi should open, as text and QR.
 * Admin links and check-in QR codes made on this PC already use it. Shows nothing elsewhere.
 */
export function PhoneAccess() {
  const lan = useLan();
  const [open, setOpen] = useState(false);
  if (!lan) return null;
  const url = lan.origins[0];

  if (!lan.reachable || !url)
    return (
      <section className="phone-access warn">
        <span className="label">Phones</span>
        <p>
          {!url
            ? 'This PC isn’t on a Wi-Fi or office network right now, so phones can’t reach it.'
            : 'Phones can’t reach this yet — it’s only running for this PC. Stop it and start it with npm run dev:phone instead (or npm run pc).'}
        </p>
      </section>
    );

  return (
    <section className="phone-access">
      <div>
        <span className="label">On a phone (same Wi-Fi)</span>
        <p>
          <a href={url}>{url.replace(/^https?:\/\//, '')}</a>
          {lan.https
            ? ' — the phone will warn about the certificate once: tap Advanced / Show details → continue.'
            : ' — plain http: phones block GPS here, so recce photos have no location. Use npm run dev:phone for recce.'}{' '}
          Admin links and check-in QR codes made on this PC already point here.
        </p>
        {lan.origins.length > 1 && <p className="hint">Other addresses of this PC: {lan.origins.slice(1).join(' · ')}</p>}
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide QR' : 'Show QR'}
        </button>
      </div>
      {open && <CheckInQr value={url} className="phone-qr" title="QR code for this PC’s address" />}
    </section>
  );
}
