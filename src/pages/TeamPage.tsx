import { useState } from 'react';
import { logout, useApp } from '../lib/db.ts';
import { addAdmin, adminLink, regenerateCode, removeAdmin, renameAdmin, storesFor } from '../lib/admins.ts';
import { askConfirm, Field, notify, PageHead, Shell, toast } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { StoreTeamLink } from '../components/StoreTeamLink.tsx';
import { shortStoreName } from '../lib/teams.ts';

/** Super admin: each store's team link, plus the (optional) personal admins and what each one is assigned. */
export function TeamPage() {
  const state = useApp((s) => s);
  const admins = Object.values(state.admins).sort((a, b) => a.name.localeCompare(b.name));
  const [form, setForm] = useState<null | { name: string; phone: string }>(null);
  const [copied, setCopied] = useState('');
  // Store team links, by campaign (newest first).
  const campaigns = Object.values(state.events)
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
    .map((e) => ({ event: e, stores: Object.values(state.stores).filter((s) => s.eventId === e.id).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((c) => c.stores.length);

  const copy = async (id: string, code: string) => {
    const link = adminLink(code);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      setTimeout(() => setCopied(''), 1800);
      toast('Link copied');
    } catch {
      void notify(`Copy this link: ${link}`);
    }
  };
  const share = async (name: string, code: string) => {
    const text = `Hi ${name.split(' ')[0]} — your Field Desk link. It shows only your stores and what to do: ${adminLink(code)}`;
    if (navigator.share) await navigator.share({ text }).catch(() => {});
    else copy('', code);
  };

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: 'Team' }]}>
      <PageHead
        kicker="Super admin"
        title="The team."
        deck="Each store gets one team link with a 4-character code, shared by everyone working that store. It opens only that store — nothing else — and each person types their name once, so reports and walk-ins say who did what."
      />

      <section className="index">
        <div className="index-head">
          <h2>Store team links</h2>
        </div>
        <p className="hint">
          One link per store, however many people work it: send it to the whole team (WhatsApp works). A new code signs everyone out; turning it off ends the link. You can also make a link from each store’s row on its campaign page.
        </p>
        {campaigns.map(({ event, stores }) => (
          <div key={event.id}>
            <div className="stl-group">{event.name}</div>
            <ul className="stl-list">
              {stores.map((s) => (
                <li key={s.id} className="stl-row">
                  <div className="stl-store">
                    <strong>{shortStoreName(s.name)}</strong>
                    <span>{[s.city, s.admin ? `admin: ${s.admin}` : ''].filter(Boolean).join(' · ') || 'No admin assigned'}</span>
                  </div>
                  <StoreTeamLink store={s} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!campaigns.length && <p className="hint">No stores yet — add stores to a campaign and each one gets a team link here.</p>}
      </section>

      <section className="index">
        <div className="index-head">
          <h2>Admins (optional)</h2>
          <button className="btn" onClick={() => setForm({ name: '', phone: '' })}>
            Add admin
          </button>
        </div>

        <p className="hint">
          A personal link is only for someone who covers <strong>several stores</strong>, or who should be named on every report. Everyone else uses their store’s team link above. Assign stores to a personal admin from a campaign’s page.
        </p>

        {form && (
          <div className="card form">
            <div className="grid2">
              <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              <Field label="Phone (optional)" type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
            </div>
            <div className="row end">
              <button className="btn ghost" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button
                className="btn accent"
                disabled={!form.name.trim()}
                onClick={() => {
                  addAdmin(form.name, form.phone);
                  toast(`${form.name.trim()} added`);
                  setForm(null);
                }}
              >
                Create link
              </button>
            </div>
          </div>
        )}

        <ol className="team fd-stagger">
          {admins.map((a, i) => {
            const stores = storesFor(state, a.id);
            return (
              <li key={a.id} className="member" style={{ ['--i' as string]: i }}>
                <div className="member-name">
                  <input aria-label="Name" value={a.name} onChange={(e) => renameAdmin(a.id, e.target.value)} />
                  <div className="label">{a.phone || 'No phone'}</div>
                  <div className="member-stores">
                    {stores.length ? stores.map((s) => `${s.name}${state.events[s.eventId] ? ` (${state.events[s.eventId].name})` : ''}`).join(' · ') : 'No stores assigned yet'}
                  </div>
                </div>
                <span className="code" title="Their personal code">
                  {a.code}
                </span>
                <div className="member-actions">
                  <button className="btn" onClick={() => copy(a.id, a.code)}>
                    {copied === a.id ? 'Copied ✓' : 'Copy link'}
                  </button>
                  <button className="btn ghost" onClick={() => share(a.name, a.code)}>
                    Share
                  </button>
                  <button className="link" onClick={async () => (await askConfirm(`Give ${a.name} a new code? Their current link stops working and their devices are signed out.`, { ok: 'New code', danger: true })) && regenerateCode(a.id)}>
                    New code
                  </button>
                  <button className="link warn" onClick={async () => (await askConfirm(`Remove ${a.name}? Their link stops working and their ${stores.length} store(s) become unassigned. Their recce work stays.`, { ok: 'Remove', danger: true })) && removeAdmin(a.id)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
          {!admins.length && !form && (
            <li className="empty-li">
              <EmptyCard mark="team" title="No personal admins." hint="Most stores only need their team link. Add a personal admin for someone who covers several stores, then assign stores to them from a campaign’s page.">
                <button className="btn accent" onClick={() => setForm({ name: '', phone: '' })}>
                  Add admin
                </button>
              </EmptyCard>
            </li>
          )}
        </ol>
      </section>

      <section className="data-tools">
        <h2>Your access</h2>
        <p className="hint">You’re signed in as super admin on this device. Admin and store team links never give access to this page, other stores, or the team list.</p>
        <div className="row">
          <button className="link" onClick={logout}>
            Sign out of this device
          </button>
        </div>
      </section>
    </Shell>
  );
}
