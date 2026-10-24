import { useMemo, useState } from 'react';
import { update, updateStore, useApp } from '../lib/db.ts';
import type { SteamAccount } from '../lib/types.ts';
import { MAX_STEAM_TEXT, purposeLabel, sortedAccounts, steamAccountName, steamUses, weekFilterKey, weekendKeyLabel, type SteamUse, type WeekFilter } from '../lib/steam.ts';
import { campaignStoreNames, storeShortName } from '../lib/names.ts';
import { cx, fmtDate, todayLocal, uid } from '../lib/util.ts';
import { askConfirm, Chip, Field, notify, PageHead, Shell, toast } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { CopyValue, DOWNLOAD_TIP, PLAY_TIP, SecretValue } from '../components/SteamCard.tsx';
import '../styles/steam.css';

const FILTERS: { id: WeekFilter; label: string }[] = [
  { id: 'this', label: 'This weekend' },
  { id: 'next', label: 'Next weekend' },
  { id: 'all', label: 'All' },
];

interface Draft {
  id: string | null; // null = a new account
  label: string;
  username: string;
  password: string;
  email: string;
  notes: string;
}
const blank = (): Draft => ({ id: null, label: '', username: '', password: '', email: '', notes: '' });

/** HQ: the Steam accounts, who has which for a weekend, and which are free. Field admins never get here (App.tsx). */
export function SteamPage() {
  const accounts = useApp((s) => s.accounts);
  const events = useApp((s) => s.events);
  const stores = useApp((s) => s.stores);
  const [filter, setFilter] = useState<WeekFilter>('this');
  const [draft, setDraft] = useState<Draft | null>(null);
  const today = todayLocal();
  const week = weekFilterKey(filter, today);

  const rows = useMemo(() => {
    const world = { events, stores };
    return sortedAccounts(accounts).map((account) => {
      const all = steamUses(world, account.id);
      const here = week === null ? all : all.filter((u) => u.week === week);
      return { account, all, here, playing: here.some((u) => u.purpose === 'play') };
    });
  }, [accounts, events, stores, week]);
  const playing = rows.filter((r) => r.playing).length;
  const free = rows.length - playing;

  const nameOf = (storeId: string) => {
    const s = stores[storeId];
    return s ? storeShortName(s.name, campaignStoreNames(Object.values(stores), s.eventId)) : 'a store';
  };
  const unassign = async (account: SteamAccount, use: SteamUse) => {
    if (!(await askConfirm(`Take ${steamAccountName(account)} away from ${nameOf(use.store.id)}? Its team stops seeing the login.`, { ok: 'Unassign', danger: true }))) return;
    updateStore(use.store.id, (s) => {
      delete s.steam;
    });
    toast('Steam account unassigned');
  };
  const remove = async (account: SteamAccount, uses: SteamUse[]) => {
    if (uses.length) {
      void notify(`${steamAccountName(account)} is still given to ${uses.map((u) => nameOf(u.store.id)).join(', ')}. Unassign it there first (the × next to each store), then delete it.`);
      return;
    }
    if (!(await askConfirm(`Delete ${steamAccountName(account)}? Its password is gone from Field Desk.`, { ok: 'Delete', danger: true }))) return;
    update((d) => {
      delete d.accounts[account.id];
    });
    toast('Steam account deleted');
  };

  return (
    <Shell crumbs={[{ label: 'Campaigns', href: '#/' }, { label: 'Steam accounts' }]}>
      <i className="hq-wide" hidden />
      <PageHead kicker="HQ" title="Steam accounts." deck="Your Steam IDs. Each store gets one for its weekend — to play with (one store per weekend) or for downloads only (as many as you like). Stores see only the login you give them." />

      <div className="sa-bar">
        <div className="seg small" role="radiogroup" aria-label="Weekend">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={cx(filter === f.id && 'on')} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn accent" onClick={() => setDraft(blank())}>
          Add account
        </button>
      </div>
      <p className="sa-summary">
        {week && <strong>{weekendKeyLabel(week)}</strong>}
        {week && rows.length > 0 && ' · '}
        {rows.length > 0 && (week ? `${free} free to play, ${playing} in use` : `${rows.length} ${rows.length === 1 ? 'account' : 'accounts'}`)}
      </p>

      {rows.length === 0 ? (
        <EmptyCard mark="team" title="No Steam accounts yet." hint="Add the Steam IDs you give to stores. You’ll pick one for each store on its campaign page.">
          <button className="btn accent" onClick={() => setDraft(blank())}>
            Add account
          </button>
        </EmptyCard>
      ) : (
        <table className="sa-table">
          <thead>
            <tr>
              <th>Steam ID</th>
              <th>Password</th>
              <th>Email</th>
              <th>{week ? 'This weekend' : 'Given to'}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ account: a, all, here, playing: busy }) => (
              <tr key={a.id}>
                <td data-label="Steam ID">
                  {a.label?.trim() && <strong className="sa-label">{a.label.trim()}</strong>}
                  <CopyValue value={a.username} what="Steam ID" />
                  {a.notes?.trim() && <div className="sa-notes">{a.notes}</div>}
                </td>
                <td data-label="Password">
                  <SecretValue value={a.password} />
                </td>
                <td data-label="Email" className={cx('sa-email', !a.email?.trim() && 'blank')}>
                  {a.email?.trim() || <span className="sa-none">—</span>}
                </td>
                <td data-label={week ? 'This weekend' : 'Given to'}>
                  <div className="sa-status">
                    {week && <Chip tone={busy ? 'warn' : 'ok'}>{busy ? 'In use' : here.length ? 'Free to play' : 'Free'}</Chip>}
                    {!week && !all.length && <Chip tone="muted">Not given out</Chip>}
                  </div>
                  <ul className="sa-uses">
                    {here.map((u) => (
                      <li key={u.store.id}>
                        <Chip tone={u.purpose === 'play' ? 'accent' : 'muted'}>{purposeLabel(u.purpose)}</Chip>
                        <a href={`#/event/${u.store.eventId}`}>{nameOf(u.store.id)}</a>
                        <button type="button" className="sa-x" aria-label={`Unassign from ${nameOf(u.store.id)}`} title="Unassign" onClick={() => unassign(a, u)}>
                          ×
                        </button>
                        <span className="sa-use-meta">
                          {events[u.store.eventId]?.name ?? 'Campaign'} · {u.date ? fmtDate(u.date, { weekday: 'short', day: 'numeric', month: 'short' }) : 'no date'}
                        </span>
                      </li>
                    ))}
                    {week && !here.length && all.length > 0 && <li className="sa-none">Given out on other weekends ({all.length})</li>}
                  </ul>
                </td>
                <td className="sa-actions">
                  <button type="button" className="link" onClick={() => setDraft({ id: a.id, label: a.label ?? '', username: a.username, password: a.password, email: a.email ?? '', notes: a.notes ?? '' })}>
                    Edit
                  </button>
                  <button type="button" className="link warn" onClick={() => remove(a, all)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="sa-tips">
        <h2>What stores are told</h2>
        <ul>
          <li>{DOWNLOAD_TIP}</li>
          <li>{PLAY_TIP}</li>
          <li>For the Steam Guard code (OTP), call HQ.</li>
        </ul>
        <p className="hint">Passwords are kept on the server and shown to the team of the store the account is given to — nobody else. Backups hold them too, so keep backups private.</p>
      </section>

      <Sheet open={!!draft} onClose={() => setDraft(null)} label={draft?.id ? 'Edit Steam account' : 'Add Steam account'}>
        {draft && <AccountForm draft={draft} accounts={accounts} onClose={() => setDraft(null)} />}
      </Sheet>
    </Shell>
  );
}

function AccountForm({ draft, accounts, onClose }: { draft: Draft; accounts: Record<string, SteamAccount>; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const username = d.username.trim();
  const clash = username && Object.values(accounts).some((a) => a.id !== d.id && a.username.trim().toLowerCase() === username.toLowerCase());
  const long = [d.label, d.username, d.password, d.email].some((v) => v.trim().length > MAX_STEAM_TEXT);
  const problem = !username ? 'The Steam ID is needed.' : !d.password.trim() ? 'The password is needed.' : clash ? 'That Steam ID is already in the list.' : long ? `Keep each field under ${MAX_STEAM_TEXT} characters.` : '';

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return;
    update((s) => {
      const id = d.id ?? uid();
      const old = s.accounts[id];
      const next: SteamAccount = { id, username, password: d.password.trim(), createdAt: old?.createdAt ?? new Date().toISOString() };
      if (d.label.trim()) next.label = d.label.trim();
      if (d.email.trim()) next.email = d.email.trim();
      if (d.notes.trim()) next.notes = d.notes.trim();
      s.accounts[id] = next;
    });
    toast(d.id ? 'Steam account saved' : 'Steam account added');
    onClose();
  };

  return (
    <form onSubmit={save} className="sa-form">
      <h2 className="sheet-title">{d.id ? 'Edit account' : 'Add account'}</h2>
      <Field label="Name for you (optional)" value={d.label} onChange={(v) => set({ label: v })} placeholder="ROG 01" />
      <Field label="Steam ID" value={d.username} onChange={(v) => set({ username: v })} />
      <Field label="Password" value={d.password} onChange={(v) => set({ password: v })} />
      <Field label="Email (optional)" type="email" value={d.email} onChange={(v) => set({ email: v })} />
      <Field label="Notes (optional)" multiline value={d.notes} onChange={(v) => set({ notes: v })} />
      <p className="hint">The email and notes are for you; the store team gets the Steam ID and password only{d.email.trim() ? ', and the email' : ''}.</p>
      {problem && d.username + d.password !== '' && <p className="hint warn">{problem}</p>}
      <div className="row end">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn accent" disabled={!!problem}>
          {d.id ? 'Save' : 'Add account'}
        </button>
      </div>
    </form>
  );
}
