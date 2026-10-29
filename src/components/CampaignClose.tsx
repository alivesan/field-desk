import { campaignComplete } from '../lib/done.ts';
import { update, useApp, useSync } from '../lib/db.ts';
import type { TournamentEvent } from '../lib/types.ts';
import { fmtDate } from '../lib/util.ts';
import { askConfirm, Chip, toast } from './ui.tsx';
import '../styles/done.css';

/**
 * Whether the campaign is complete, and HQ's button to say so. It is complete once every store is finished
 * (automatically, or marked by HQ), or when HQ closes it by hand (event.closedAt) — for a campaign that
 * ended with stores that never played. Reopen takes the hand-made close back; if every store is finished it still counts as complete.
 */
export function CampaignClose({ event }: { event: TournamentEvent }) {
  const { role } = useSync();
  const stores = useApp((s) => s.stores);
  const c = campaignComplete(event, Object.values(stores));

  const close = async () => {
    const open = c.total - c.finished;
    const text = `Close ${event.name}?${open > 0 ? ` ${open} store${open === 1 ? ' isn’t' : 's aren’t'} marked finished yet.` : ''} It shows as Completed for HQ; Reopen campaign takes it back.`;
    if (!(await askConfirm(text, { ok: 'Close campaign' }))) return;
    update((d) => void (d.events[event.id] && (d.events[event.id].closedAt = new Date().toISOString())));
    toast('Campaign closed ✓');
  };
  const reopen = async () => {
    if (!(await askConfirm(`Reopen ${event.name}? It stops showing as completed${c.finished === c.total && c.total > 0 ? ' — unless every store is finished' : ''}.`, { ok: 'Reopen campaign' }))) return;
    update((d) => void (d.events[event.id] && delete d.events[event.id].closedAt));
    toast('Campaign reopened');
  };

  return (
    <span className="finish">
      {c.complete ? <Chip tone="ok">Completed ✓{c.at ? ` ${fmtDate(c.at, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</Chip> : <Chip tone="muted">{c.total ? `${c.finished} of ${c.total} stores finished` : 'No stores yet'}</Chip>}
      {c.complete && <span className="finish-note">{c.how === 'manual' ? 'Closed by HQ' : 'Every store is finished'}</span>}
      {role === 'super' && !c.complete && (
        <button className="btn ghost" onClick={close}>
          Close campaign
        </button>
      )}
      {role === 'super' && event.closedAt && (
        <button className="link" onClick={reopen}>
          Reopen campaign
        </button>
      )}
    </span>
  );
}
