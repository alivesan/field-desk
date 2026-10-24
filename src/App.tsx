import { useEffect } from 'react';
import { useRoute } from './lib/router.ts';
import { loadLan } from './lib/origin.ts';
import { useApp, useSync } from './lib/db.ts';
import { matchDayOpen } from './lib/gate.ts';
import { todayLocal } from './lib/util.ts';
import { AccessGate, NamePrompt, NotFound, Shell, Skeleton, useNow } from './components/ui.tsx';
import { MatchDayGate } from './components/MatchDayGate.tsx';
import { Home } from './pages/Home.tsx';
import { AdminHome } from './pages/AdminHome.tsx';
import { TeamPage } from './pages/TeamPage.tsx';
import { EventPage } from './pages/EventPage.tsx';
import { ReccePage } from './pages/ReccePage.tsx';
import { ReportPage } from './pages/ReportPage.tsx';
import { DayPage } from './pages/DayPage.tsx';
import { BoardPage } from './pages/BoardPage.tsx';
import { StoreSetupPage } from './pages/StoreSetupPage.tsx';
import { WinnersPage } from './pages/WinnersPage.tsx';
import { SteamPage } from './pages/SteamPage.tsx';

export function App() {
  const [a, id, view] = useRoute();
  const { status, role, needsName } = useSync();
  useEffect(() => {
    if (role) loadLan();
  }, [role]);
  if (status === 'locked') return <AccessGate />;
  if (!role)
    return (
      <Shell>
        <div className="phead connecting fd-enter" role="status" aria-busy="true">
          <span className="sr-only">Connecting… reaching the server to check who you are.</span>
          <Skeleton w={84} h={11} />
          <Skeleton w="min(360px, 72%)" h={48} className="sk-title" />
          <Skeleton w="min(300px, 60%)" h={14} />
        </div>
      </Shell>
    );

  if (needsName) return <NamePrompt />; // a store team's code: who is on this phone?

  if (a === 'store' && id) {
    if (view === 'recce') return <ReccePage key={id} storeId={id} />;
    if (view === 'report') return <ReportPage key={id} storeId={id} />;
    if (view === 'day' || view === 'board') return <MatchDayRoute key={id} storeId={id} view={view} role={role} />;
    if (view === 'players') return role === 'super' ? <StoreSetupPage key={id} storeId={id} /> : <NotFound />;
  }

  // A field admin has one home and their own stores — nothing else exists for them.
  if (role === 'admin') return a === 'store' || a === 'winners' || a === 'steam' ? <NotFound /> : <AdminHome />;

  if (!a) return <Home />;
  if (a === 'team') return <TeamPage />;
  if (a === 'winners') return <WinnersPage eventId={id} />;
  if (a === 'steam') return <SteamPage />;
  if (a === 'event' && id) return <EventPage key={id} eventId={id} />;
  return <NotFound />;
}

/** Match day and the venue board: a field admin gets a gate page until HQ has checked the recce (or the event date comes). */
function MatchDayRoute({ storeId, view, role }: { storeId: string; view: 'day' | 'board'; role: 'super' | 'admin' }) {
  const store = useApp((s) => s.stores[storeId]);
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const now = useNow(60000);
  if (store && event && !matchDayOpen(store, event, todayLocal(new Date(now)), role).open) return <MatchDayGate store={store} event={event} view={view} />;
  return view === 'day' ? <DayPage storeId={storeId} /> : <BoardPage storeId={storeId} />;
}
