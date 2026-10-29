import { dayVersion } from '../lib/commands.ts';
import { storeFinished } from '../lib/done.ts';
import { useApp, useSync } from '../lib/db.ts';
import type { Store } from '../lib/types.ts';
import { fmtDate } from '../lib/util.ts';
import { askConfirm, Chip, notify, toast } from './ui.tsx';
import { useHqCommand } from './hqCommand.ts';
import '../styles/done.css';

/** What "Mark finished" / "Reopen" say before they act — shared with the store's HQ page. */
export const markFinishedText = (name: string) =>
  `Mark ${name} as finished? Use it when the event is over but the winner details were never saved here. It shows as Finished for HQ and for the store’s team; Reopen takes it back.`;

/**
 * A store's "event finished" state for HQ, as a compact line: a Finished chip (automatic, or marked by HQ) and
 * the button that fits — Mark finished, or Reopen for a hand-made mark. A finish that happened by itself (the
 * final is played and the winner details are saved) has no button: it follows the bracket. Others see the chip only.
 */
export function StoreFinish({ store }: { store: Store }) {
  const { role } = useSync();
  const event = useApp((s) => s.events[store.eventId]);
  const send = useHqCommand();
  const fin = storeFinished(store, event);

  const mark = async () => {
    if (!(await askConfirm(markFinishedText(store.name), { ok: 'Mark finished' }))) return;
    const problem = send(store.id, (s) => ({ type: 'event.finish', base: dayVersion(s) }));
    if (problem) void notify(problem);
    else toast('Marked finished ✓');
  };
  const reopen = async () => {
    if (!(await askConfirm(`Reopen ${store.name}? It stops showing as finished${fin.how === 'manual' ? ' (unless its final is played and the winner details are saved)' : ''}.`, { ok: 'Reopen' }))) return;
    const problem = send(store.id, (s) => ({ type: 'event.reopen', base: dayVersion(s) }));
    if (problem) void notify(problem);
    else toast('Reopened');
  };

  return (
    <span className="finish">
      {fin.finished ? (
        <Chip tone="ok">{fin.how === 'manual' ? `Finished ✓ · marked by ${fin.by || 'HQ'}` : 'Finished ✓'}</Chip>
      ) : (
        <Chip tone="muted">Not finished</Chip>
      )}
      {fin.finished && fin.at && <span className="finish-note">{fin.how === 'auto' ? 'Winner details saved' : 'Marked'} {fmtDate(fin.at, { day: 'numeric', month: 'short' })}</span>}
      {role === 'super' && !fin.finished && (
        <button className="btn ghost" onClick={mark}>
          Mark finished
        </button>
      )}
      {role === 'super' && store.finishedAt && (
        <button className="link" onClick={reopen}>
          Reopen
        </button>
      )}
    </span>
  );
}
