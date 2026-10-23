import { useState } from 'react';
import { logout, useApp } from '../lib/db.ts';
import { addAdmin, adminLink, regenerateCode, removeAdmin, renameAdmin, storesFor } from '../lib/admins.ts';
import { askConfirm, Field, PageHead, Shell } from '../components/ui.tsx';

/** Super admin: the field team, their personal links, and what each one is assigned. */
export function TeamPage() {
  const state = useApp((s) => s);
  const admins = Object.values(state.admins).sort((a, b) => a.name.localeCompare(b.name));
  const [form, setForm] = useState<null | { name: string; phone: string }>(null);
  const [copied, setCopied] = useState('');

  const copy = async (id: string, code: string) => {
    const link = adminLink(code);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(id);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      prompt('Copy this link:', link);
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
        deck="Each admin gets a personal link with a 4-character code. It opens only the stores you assign them — nothing else. Assign stores from a campaign’s page."
      />

      <section className="index">
        <div className="index-head">
          <h2>Admins</h2>
          <button className="btn" onClick={() => setForm({ name: '', phone: '' })}>
            Add admin
          </button>
        </div>

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
                  setForm(null);
                }}
              >
                Create link
              </button>
            </div>
          </div>
        )}

        <ol className="team">
          {admins.map((a) => {
            const stores = storesFor(state, a.id);
            return (
              <li key={a.id} className="member">
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
          {!admins.length && !form && <li className="empty">No admins yet. Add one to get their link.</li>}
        </ol>
      </section>

      <section className="data-tools">
        <h2>Your access</h2>
        <p className="hint">You’re signed in as super admin on this device. Admin links never give access to this page, other stores, or the team list.</p>
        <div className="row">
          <button className="link" onClick={logout}>
            Sign out of this device
          </button>
        </div>
      </section>
    </Shell>
  );
}
