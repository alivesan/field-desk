import { useState } from 'react';
import { update } from '../lib/db.ts';
import { base64url } from '../lib/checkin.ts';
import { shareOrigin, useLan } from '../lib/origin.ts';
import type { TournamentEvent } from '../lib/types.ts';
import { askConfirm, notify, toast } from './ui.tsx';
import '../styles/team.css';
import '../styles/print.css';

/** 16 random bytes → 22 url-safe characters (128 bits): the print desk's link can't be guessed. */
export const newPrintToken = () => base64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

export const printDeskShareText = (campaign: string, link: string) => `Print files for ${campaign} — open on your phone or PC, no sign-in: ${link}`;

/**
 * HQ: the print desk's link (event.printDesk) — one public page with this week's files of every
 * store, for whoever does the printing. Make it, copy or share it, make a new one (the old link stops
 * working at once) or turn it off.
 */
export function PrintDeskLink({ event }: { event: TournamentEvent }) {
  useLan(); // the PC's Wi-Fi address, once known, replaces "localhost" in the link
  const [copied, setCopied] = useState(false);
  const token = event.printDesk?.token;
  const link = token ? `${shareOrigin()}/p/${token}` : '';

  const set = (on: boolean) =>
    update((d) => {
      const e = d.events[event.id];
      if (!e) return;
      if (on) e.printDesk = { token: newPrintToken(), createdAt: new Date().toISOString() };
      else delete e.printDesk;
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast('Link copied');
    } catch {
      void notify(`Copy this link: ${link}`);
    }
  };
  const share = async () => {
    const text = printDeskShareText(event.name, link);
    if (navigator.share) await navigator.share({ text }).catch(() => {});
    else {
      const w = window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      if (!w) void copy();
    }
  };

  if (!token)
    return (
      <div className="pdl">
        <div>
          <b>Print desk link</b>
          <p className="hint">For whoever prints: one link with every store’s files, downloadable with the right names. No sign-in.</p>
        </div>
        <button className="btn" onClick={() => set(true)}>
          Create print desk link
        </button>
      </div>
    );
  return (
    <div className="pdl on">
      <div>
        <b>Print desk link</b>
        <p className="hint">Anyone with this link can download this week’s files — send it only to whoever prints.</p>
      </div>
      <div className="stl on">
        <span className="stl-url" title={link}>
          {link.replace(/^https?:\/\//, '')}
        </span>
        <div className="stl-actions">
          <button className="btn" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button className="btn ghost" onClick={share}>
            Share
          </button>
          <a className="link" href={link} target="_blank" rel="noreferrer">
            Open
          </a>
          <button className="link" onClick={async () => (await askConfirm('Make a new print desk link? The old link stops working right away, so send the new one to whoever prints.', { ok: 'New link', danger: true })) && set(true)}>
            New link
          </button>
          <button className="link warn" onClick={async () => (await askConfirm('Turn off the print desk link? Anyone who has it will see that it isn’t valid any more.', { ok: 'Turn off', danger: true })) && set(false)}>
            Turn off
          </button>
        </div>
      </div>
    </div>
  );
}
