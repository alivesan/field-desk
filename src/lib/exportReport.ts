import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Report } from '../components/Report.tsx';
import type { Store, TournamentEvent } from './types.ts';
import { evidenceBanner } from './evidence.ts';
import type { LoadedEvidence } from './evidenceLoad.ts';
import type { AnySubmission } from './submission.ts';
import { blobToDataUrl, slug } from './util.ts';
import baseCss from '../styles/base.css?raw';
import reportCss from '../styles/report.css?raw';
import evidenceCss from '../styles/evidence.css?raw';

/**
 * A single self-contained HTML file (photos embedded) that can be emailed or shared to HQ.
 * `evidence` comes from loadEvidence() for the same revision: only photos that decoded are
 * embedded, and if any are missing the file carries a banner listing them.
 */
export async function buildReportFile(event: TournamentEvent, store: Store, opts: { submission?: AnySubmission; evidence: LoadedEvidence; draftNote?: string }) {
  const data: Record<string, string> = {};
  for (const [id, b] of Object.entries(opts.evidence.blobs)) data[id] = await blobToDataUrl(b);
  const m = opts.evidence.result;
  const banner = evidenceBanner(m);

  const body = renderToStaticMarkup(
    createElement(Report, {
      event,
      store,
      submission: opts.submission,
      src: (id: string) => data[id],
      generatedAt: new Date().toISOString(),
      banner,
      evidenceNote: banner ? undefined : m.expected ? `All ${m.expected} proof photo${m.expected === 1 ? '' : 's'} included.` : undefined,
      draftNote: opts.draftNote,
    }),
  );
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recce — ${esc(store.name)} — ${esc(event.name)}${banner ? ' (incomplete)' : ''}</title>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${baseCss}\n${reportCss}\n${evidenceCss}\nbody{padding:24px 16px 64px}</style></head>
<body>${body}</body></html>`;

  const rev = opts.submission && opts.submission.rev > 0 ? `-rev${opts.submission.rev}` : opts.submission ? '' : '-draft';
  const name = `recce-${slug(event.name)}-${slug(store.name)}${rev}${banner ? '-INCOMPLETE' : ''}.html`;
  return new File([html], name, { type: 'text/html' });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
