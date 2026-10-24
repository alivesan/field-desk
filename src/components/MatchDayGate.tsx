import { usePendingWork } from '../lib/db.ts';
import { storeDate } from '../lib/recce.ts';
import { submissionState } from '../lib/submission.ts';
import type { Store, TournamentEvent } from '../lib/types.ts';
import { fmtDate } from '../lib/util.ts';
import { PageHead, Shell } from './ui.tsx';
import { useStoreName } from './useStoreName.ts';

/** What a field admin sees at #/store/<id>/day or /board while HQ hasn't checked the recce and it isn't the event date yet. */
export function MatchDayGate({ store, event, view }: { store: Store; event: TournamentEvent; view: 'day' | 'board' }) {
  const { short } = useStoreName(store);
  const st = submissionState(store, usePendingWork(store.id));
  const date = fmtDate(storeDate(store, event), { weekday: 'long', day: 'numeric', month: 'long' });
  const sent = !!st.acknowledged;
  const label = st.kind === 'failed' ? 'Fix the recce submission' : st.kind === 'draft' ? (sent ? 'Submit the recce update' : 'Go to the recce') : 'Open the recce';
  return (
    <Shell crumbs={[{ label: 'My stores', href: '#/' }, { label: short }, { label: view === 'board' ? 'Venue board' : 'Match day' }]}>
      <PageHead
        kicker={short}
        title="Match day isn’t open yet."
        deck={
          sent
            ? `Your recce is with HQ. Match day opens as soon as they’ve checked it — or on ${date}, whichever comes first.`
            : `Match day opens once HQ has checked your recce — or on ${date}, whichever comes first. Finish the recce and send it to HQ.`
        }
      />
      <div className="gate-actions">
        <a className="btn accent" href={`#/store/${store.id}/recce`}>
          {label} →
        </a>
        <a className="btn ghost" href="#/">
          Back to my stores
        </a>
      </div>
    </Shell>
  );
}
