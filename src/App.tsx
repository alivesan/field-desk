import { useEffect } from 'react';
import { useRoute } from './lib/router.ts';
import { loadLan } from './lib/origin.ts';
import { useSync } from './lib/db.ts';
import { AccessGate, NotFound, PageHead, Shell } from './components/ui.tsx';
import { Home } from './pages/Home.tsx';
import { AdminHome } from './pages/AdminHome.tsx';
import { TeamPage } from './pages/TeamPage.tsx';
import { EventPage } from './pages/EventPage.tsx';
import { ReccePage } from './pages/ReccePage.tsx';
import { ReportPage } from './pages/ReportPage.tsx';
import { DayPage } from './pages/DayPage.tsx';
import { BoardPage } from './pages/BoardPage.tsx';
import { StoreSetupPage } from './pages/StoreSetupPage.tsx';

export function App() {
  const [a, id, view] = useRoute();
  const { status, role } = useSync();
  useEffect(() => {
    if (role) loadLan();
  }, [role]);
  if (status === 'locked') return <AccessGate />;
  if (!role)
    return (
      <Shell>
        <PageHead kicker="Field Desk" title="Connecting…" deck="Reaching the server to check who you are." />
      </Shell>
    );

  if (a === 'store' && id) {
    if (view === 'recce') return <ReccePage key={id} storeId={id} />;
    if (view === 'report') return <ReportPage key={id} storeId={id} />;
    if (view === 'day') return <DayPage key={id} storeId={id} />;
    if (view === 'board') return <BoardPage key={id} storeId={id} />;
    if (view === 'players') return role === 'super' ? <StoreSetupPage key={id} storeId={id} /> : <NotFound />;
  }

  // A field admin has one home and their own stores — nothing else exists for them.
  if (role === 'admin') return a === 'store' ? <NotFound /> : <AdminHome />;

  if (!a) return <Home />;
  if (a === 'team') return <TeamPage />;
  if (a === 'event' && id) return <EventPage key={id} eventId={id} />;
  return <NotFound />;
}
