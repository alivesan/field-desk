import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary, StartupFailure } from './components/ErrorBoundary.tsx';
import { CheckInPage } from './pages/CheckInPage.tsx';
import { ConfirmHost, ToastHost } from './components/ui.tsx';
import { loadState } from './lib/db.ts';
import './styles/base.css';
import './styles/motion.css';
import './styles/app.css';
import './styles/report.css';
import './styles/sync.css';
import './styles/flair.css';

const root = createRoot(document.getElementById('root')!);

// A player's QR check-in link is https://host/c/<token>. It's public: no sign-in, no sync engine,
// no local storage of anyone's data — just the check-in form. Never starts the staff app.
const checkInToken = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{16,64})\/?$/)?.[1];

if (checkInToken) {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <CheckInPage token={checkInToken} />
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  // A field admin's personal link is https://host/K7Q2 — take the code, then tidy the URL.
  const code = location.pathname.match(/^\/([A-Za-z0-9]{4})\/?$/)?.[1];
  if (code) history.replaceState(null, '', '/' + location.hash);

  loadState(code).then(
    () =>
      root.render(
        <StrictMode>
          <ErrorBoundary>
            <App />
            <ConfirmHost />
            <ToastHost />
          </ErrorBoundary>
        </StrictMode>,
      ),
    (error) => root.render(<StartupFailure error={error} />),
  );
}
