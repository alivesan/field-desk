import { Component, useState, type ReactNode } from 'react';
import { uid } from '../lib/util.ts';

/*
 * Containment, not validation: if a screen throws while rendering, show a recovery screen
 * instead of a blank page. Work already queued on this device is untouched by a render error
 * and keeps syncing once the page is reloaded. The diagnostic id is logged with the full
 * error to the console; what can be copied carries no data or secrets.
 */

function diagnostic(error: unknown, id: string) {
  const name = (error as { name?: string })?.name ?? 'Error';
  return `Field Desk ${id} · ${new Date().toISOString()} · ${name} · ${location.hash.split('?')[0] || '#/'}`;
}

function Recovery({ title, deck, id, error }: { title: string; deck: string; id: string; error: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = diagnostic(error, id);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      prompt('Copy this for HQ:', text);
    }
  };
  return (
    <div className="recover" role="alert">
      <div>
        <div className="mast-mark">Field Desk</div>
        <h1>{title}</h1>
        <p className="deck">{deck}</p>
        <div className="row">
          <button type="button" className="btn accent" onClick={() => location.reload()}>
            Reload
          </button>
          <button type="button" className="btn ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy diagnostic id'}
          </button>
        </div>
        <p className="deck">
          <code>{id}</code>
        </p>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; id: string | null }> {
  state = { error: null as unknown, id: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error, id: uid() };
  }
  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error(`[field-desk] render error ${this.state.id}`, error, info.componentStack);
  }
  render() {
    if (this.state.id)
      return (
        <Recovery
          title="This screen hit a problem."
          deck="Your saved and queued work on this device is safe. Reload to continue; if it happens again, send the diagnostic id to HQ."
          id={this.state.id}
          error={this.state.error}
        />
      );
    return this.props.children;
  }
}

/** Shown when the app couldn't start at all (e.g. storage or a startup error). */
export function StartupFailure({ error }: { error: unknown }) {
  const [id] = useState(() => {
    const i = uid();
    console.error(`[field-desk] startup error ${i}`, error);
    return i;
  });
  return (
    <Recovery
      title="Field Desk couldn’t start."
      deck="Check your connection and reload. Anything already saved on this device stays saved. If it keeps happening, send the diagnostic id to HQ."
      id={id}
      error={error}
    />
  );
}
