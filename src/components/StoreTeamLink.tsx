import { useState } from 'react';
import { update } from '../lib/db.ts';
import { adminLink, newCode } from '../lib/admins.ts';
import { shortStoreName, usedCodes } from '../lib/teams.ts';
import type { Store } from '../lib/types.ts';
import { askConfirm, notify, toast } from './ui.tsx';
import '../styles/team.css';

/** The text HQ sends to a store team: one link for everyone working that store. */
export const teamShareText = (storeName: string, link: string) => `Field Desk link for ${storeName} — open it on your phone: ${link}`;

/**
 * HQ: the store team's one shared link (Store.access). Anyone who opens it works that store —
 * no login per person; each types their name once. A new code signs everyone out; turning it off
 * ends the link. Shown on each store row of a campaign and on the Team page.
 */
export function StoreTeamLink({ store }: { store: Store }) {
  const [copied, setCopied] = useState(false);
  const code = store.access?.code;
  const link = code ? adminLink(code) : '';

  // Codes are 4 characters across admins and stores alike, so pick one nobody has (the server checks too).
  const setCode = (on: boolean) =>
    update((d) => {
      const s = d.stores[store.id];
      if (!s) return;
      if (on) s.access = { code: newCode(usedCodes(d)), createdAt: new Date().toISOString() };
      else delete s.access;
      s.updatedAt = new Date().toISOString();
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
    const text = teamShareText(shortStoreName(store.name), link);
    if (navigator.share) await navigator.share({ text }).catch(() => {});
    else {
      // No share sheet (a desktop browser): WhatsApp Web / app takes the text.
      const w = window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      if (!w) void copy();
    }
  };

  if (!code) {
    return (
      <div className="stl">
        <button className="btn" onClick={() => setCode(true)} title="One link for everyone working this store">
          Create team link
        </button>
      </div>
    );
  }
  return (
    <div className="stl on">
      <span className="stl-code" title="The store team’s code">
        {code}
      </span>
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
        <button
          className="link"
          onClick={async () => (await askConfirm(`Make a new code for ${shortStoreName(store.name)}? Everyone signed in with the old code is signed out, and the old link stops working.`, { ok: 'New code', danger: true })) && setCode(true)}
        >
          New code
        </button>
        <button
          className="link warn"
          onClick={async () => (await askConfirm(`Turn off the team link for ${shortStoreName(store.name)}? Everyone signed in with it is signed out. Their recce work stays.`, { ok: 'Turn off', danger: true })) && setCode(false)}
        >
          Turn off
        </button>
      </div>
    </div>
  );
}
