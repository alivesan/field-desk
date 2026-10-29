import { updateStore, useApp, useSync } from '../lib/db.ts';
import { storeCrumbs } from '../lib/admins.ts';
import { PRINT_KINDS } from '../lib/print.ts';
import { downloadedBy, driveView, printShopText } from '../lib/printShare.ts';
import { printRow } from '../lib/printRow.ts';
import type { PrintKind } from '../lib/types.ts';
import { ago, fmtDate } from '../lib/util.ts';
import { storeDate } from '../lib/recce.ts';
import { Chip, NotFound, PageHead, Shell, toast, useNow } from '../components/ui.tsx';
import { EmptyCard } from '../components/flair.tsx';
import { PrintFileCard, shareText, type PrintItem } from '../components/PrintCards.tsx';
import { useStoreName } from '../components/useStoreName.ts';
import '../styles/print.css';

/**
 * Print files, for a store team (or its admin, or HQ): the five files HQ imported from the
 * creatives sheet, each with its print instruction, ready to put on a phone — saved with the right
 * name, or shared as the real file — plus one message that sends everything to the print shop.
 */
export function PrintPage({ storeId }: { storeId: string }) {
  const store = useApp((s) => s.stores[storeId]);
  const event = useApp((s) => (store ? s.events[store.eventId] : undefined));
  const { short } = useStoreName(store);
  const { role, name, team } = useSync();
  const now = useNow(60000);
  if (!store || !event) return <NotFound />;

  const kit = store.print;
  const byKind = new Map(kit?.files.map((f) => [f.kind, f]));
  const items = PRINT_KINDS.flatMap((kind): PrintItem[] => {
    const f = byKind.get(kind);
    return f ? [{ ...printRow(event, kind), driveId: f.driveId, link: f.url || driveView(f.driveId) }] : [];
  });
  const downloads = store.printDownloads ?? {};
  const savedCount = items.filter((i) => downloads[i.kind]).length;
  // A kit that HQ's latest refresh didn't touch is last week's (or an earlier try): say so before anyone prints it.
  const latest = event.printSheet?.importedAt;
  const stale = !!kit && !!latest && kit.importedAt < latest;

  // Saving or sharing a file is written on the store, so the whole team (and HQ) sees which are done.
  const got = (kinds: PrintKind[]) => {
    const by = downloadedBy(name, team);
    const at = new Date().toISOString();
    updateStore(store.id, (s) => {
      for (const kind of kinds) (s.printDownloads ??= {})[kind] = { at, by };
    });
  };

  const sendToShop = () => void shareText(printShopText(short, items));

  return (
    <Shell crumbs={storeCrumbs(role, event, store, { label: 'Print files' })}>
      <PageHead
        kicker={`Print files · ${fmtDate(storeDate(store, event), { weekday: 'short', day: 'numeric', month: 'short' })} · ${event.name}`}
        title={short}
        deck={items.length ? 'Save each file to the phone, or share it to whoever prints. Print sizes and copies are on every card.' : undefined}
      >
        {items.length > 0 && (
          <div className="pf-status">
            <Chip tone={savedCount === items.length ? 'ok' : 'warn'}>{savedCount === items.length ? 'All saved ✓' : `${savedCount} of ${items.length} saved`}</Chip>
            {kit?.importedAt && <span className="label">From {kit.tab ? `${kit.tab} · ` : ''}sheet read {ago(kit.importedAt, now)}</span>}
          </div>
        )}
      </PageHead>

      {!items.length ? (
        <EmptyCard mark="campaign" title="No print files yet." hint="HQ hasn’t added this week’s print files yet. They show up here by themselves once HQ does — no need to refresh.">
          <a className="btn ghost" href={role === 'admin' ? '#/' : `#/event/${event.id}`}>
            {role === 'admin' ? 'Back to my stores' : 'Back to the campaign'}
          </a>
        </EmptyCard>
      ) : (
        <>
          {stale && (
            <p className="pf-note warn" role="status">
              HQ has read a newer sheet since these were added. Ask HQ before printing them.
            </p>
          )}

          <section className="pf-shop">
            <div>
              <h2>Send to print shop</h2>
              <p className="hint">One message with all {items.length} files, their sizes, copies and links — the originals, nothing compressed. Pick the print shop’s WhatsApp.</p>
            </div>
            <button className="btn accent" onClick={sendToShop}>
              Send to print shop
            </button>
          </section>
          <p className="pf-tip">
            <b>Sending files yourself?</b> In WhatsApp choose <b>Document</b>, not Photo — photos get compressed.
          </p>

          <ul className="pf-list big fd-stagger">
            {PRINT_KINDS.map((kind, i) => {
              const item = items.find((x) => x.kind === kind);
              if (!item)
                return (
                  <li key={kind} className="pf big missing" style={{ ['--i' as string]: i }}>
                    <div className="pf-body">
                      <h3 className="pf-label">{printRow(event, kind).label}</h3>
                      <p className="pf-spec">HQ’s sheet didn’t have this file. Ask HQ to add it.</p>
                    </div>
                  </li>
                );
              return (
                <PrintFileCard
                  key={kind}
                  item={item}
                  storeName={short}
                  saveHref={`/api/print/file/${encodeURIComponent(store.id)}/${kind}`}
                  viewHref={`/api/print/file/${encodeURIComponent(store.id)}/${kind}?inline=1`}
                  variant="big"
                  saved={downloads[kind]}
                  index={i}
                  onGot={() => got([kind])}
                />
              );
            })}
          </ul>

          <p className="pf-zip">
            <a className="link" href={`/api/print/zip/${encodeURIComponent(store.id)}`} download onClick={() => got(items.map((i) => i.kind))}>
              Download all (zip)
            </a>
          </p>
        </>
      )}
    </Shell>
  );
}
