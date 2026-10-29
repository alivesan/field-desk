import { PRINT_KINDS } from '../lib/print.ts';
import type { Store } from '../lib/types.ts';
import { cx } from '../lib/util.ts';
import { Chip } from './ui.tsx';
import '../styles/print.css';

/** How many of a store's print files there are, and how many of those someone has saved or shared. */
export function printProgress(store: Pick<Store, 'print' | 'printDownloads'>) {
  const kinds = PRINT_KINDS.filter((k) => store.print?.files.some((f) => f.kind === k));
  return { ready: kinds.length, saved: kinds.filter((k) => store.printDownloads?.[k]).length };
}

/**
 * The way into a store's print files: a card on the admin home ("Print files · 5 ready", with a badge until
 * every file has been saved) or a one-line link in the recce's collateral section. Nothing when HQ hasn't
 * added the store's files.
 */
export function PrintEntry({ store, line }: { store: Store; line?: boolean }) {
  const { ready, saved } = printProgress(store);
  if (!ready) return null;
  const all = saved >= ready;
  return (
    <a className={cx('pe', line && 'line', all && 'done')} href={`#/store/${store.id}/print`}>
      <span className="pe-text">
        <b>Print files · {ready} ready</b>
        {!line && <small>Standee, posters, pamphlets and cheques — save them to the phone or send them to the print shop.</small>}
      </span>
      <Chip tone={all ? 'ok' : 'accent'}>{all ? 'All saved ✓' : `${ready - saved} to save`}</Chip>
      <span className="pe-go" aria-hidden>
        →
      </span>
    </a>
  );
}
