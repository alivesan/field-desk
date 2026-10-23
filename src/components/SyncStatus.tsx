import { useEffect, useRef, useState } from 'react';
import { discardWork, exportWork, retryWork, sendHeldWork, useApp, usePendingWork, useSync, type PendingWork } from '../lib/db.ts';
import { ago, cx, fmtTime } from '../lib/util.ts';
import { askConfirm } from './ui.tsx';

/**
 * Header badge: is this device's work on the server yet? Opens a panel listing everything
 * that isn't — queued, failed, conflicted, or held from before the update — with the reason
 * and what can be done about it. Replaces SyncBadge (src/components/ui.tsx).
 */
export function SyncStatus() {
  const sync = useSync();
  const work = usePendingWork();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const attention = sync.failed + sync.held;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { status, pending } = sync;
  const text =
    status === 'locked'
      ? 'Signed out'
      : status === 'storage-error'
        ? 'Storage problem'
        : attention
          ? `${attention} need${attention === 1 ? 's' : ''} attention`
          : status === 'live'
            ? pending
              ? `Syncing ${pending}`
              : 'Live'
            : status === 'offline'
              ? pending
                ? `Offline · ${pending} waiting`
                : 'Offline'
              : 'Connecting';
  const title =
    status === 'storage-error'
      ? (sync.storageError ?? undefined)
      : status === 'offline' && pending
        ? 'Saved on this phone — it will send automatically when there’s signal.'
        : undefined;

  return (
    <div className="syncs" ref={root}>
      <button
        type="button"
        className={cx('sync', 'syncs-badge', status, pending > 0 && 'pending', attention > 0 && 'attention')}
        title={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <i aria-hidden />
        {text}
      </button>
      {open && <SyncPanel work={work} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SyncPanel({ work, onClose }: { work: PendingWork[]; onClose: () => void }) {
  const sync = useSync();
  const stores = useApp((s) => s.stores);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const held = work.filter((w) => w.held);
  const rest = work.filter((w) => !w.held);
  const unsaved = work.filter((w) => !w.saved).length;

  const connection =
    sync.connection === 'live' ? 'Connected' : sync.connection === 'offline' ? 'No connection — work is kept and sent when there’s signal' : sync.connection === 'locked' ? 'Signed out' : 'Connecting…';

  return (
    <div className="syncs-panel" role="dialog" aria-label="Sync status">
      <div className="syncs-head">
        <div>
          <div className="label">This device</div>
          <p className="syncs-line">
            {connection}
            {sync.lastSyncAt && <small> · updated {ago(sync.lastSyncAt)}</small>}
          </p>
        </div>
        <button type="button" className="syncs-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {sync.storageError && (
        <p className="syncs-alert">
          {sync.storageError}
          {unsaved > 0 && ` ${unsaved} item${unsaved > 1 ? 's are' : ' is'} not saved on this device.`}
        </p>
      )}

      {!work.length && <p className="syncs-empty">Everything on this device has reached the server.</p>}

      {held.length > 0 && (
        <section className="syncs-group">
          <div className="syncs-group-head">
            <span className="label">From before the update</span>
            <button type="button" className="link" onClick={async () => (await askConfirm(`Send ${held.length} item${held.length > 1 ? 's' : ''} saved before the update, as you?`, { ok: 'Send as me' })) && sendHeldWork()}>
              Send as me
            </button>
          </div>
          <p className="syncs-note">Saved on this device by the previous version and never confirmed. Check them before sending — or export and discard.</p>
          <WorkList items={held} stores={stores} />
        </section>
      )}

      {rest.length > 0 && (
        <section className="syncs-group">
          <WorkList items={rest} stores={stores} />
        </section>
      )}

      {work.length > 0 && (
        <div className="syncs-foot">
          <button type="button" className="btn ghost" onClick={() => void exportWork()}>
            Export unsent work
          </button>
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<PendingWork['state'], string> = { queued: 'Waiting', sending: 'Sending', failed: 'Not accepted', conflict: 'Conflict' };

function WorkList({ items, stores }: { items: PendingWork[]; stores: Record<string, { name: string }> }) {
  return (
    <ul className="syncs-list">
      {items.map((w) => {
        const stuck = w.held || w.state === 'failed' || w.state === 'conflict';
        return (
          <li key={w.id} className={cx('syncs-item', w.state, w.held && 'held')}>
            <div className="syncs-item-top">
              <strong>{w.storeId ? (stores[w.storeId]?.name ?? 'A store not on this device') : 'Campaign / team'}</strong>
              <span className={cx('chip', w.state === 'queued' || w.state === 'sending' ? 'muted' : 'warn')}>{w.held ? 'Held' : STATE_LABEL[w.state]}</span>
            </div>
            <div className="syncs-item-what">
              {w.kind === 'upload' ? 'Photo' : w.kind === 'cmd' ? `Action: ${w.summary}` : `Edit: ${w.summary}`} · {fmtTime(w.createdAt)}
              {!w.saved && <em> · not saved on this device</em>}
            </div>
            {(w.error || w.note) && <p className="syncs-why">{w.error ?? w.note}</p>}
            {stuck && (
              <div className="syncs-actions">
                <button type="button" className="link" onClick={() => retryWork(w.id)}>
                  {w.held ? 'Send as me' : 'Retry'}
                </button>
                <button type="button" className="link warn" onClick={async () => (await askConfirm('Discard this? It will not reach the server. Export first if you might need it.', { ok: 'Discard', danger: true })) && discardWork(w.id)}>
                  Discard
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
