/*
 * What the print-files screens say: the "Send to print shop" message, the text that goes with a shared
 * file, the instruction line on a card, and the download name read from a Content-Disposition header.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiesText, dispositionName, downloadedBy, driveThumb, driveView, fileShareText, printShopText, specLine } from '../src/lib/printShare.ts';
import { printRow } from '../src/lib/printRow.ts';

const poster = { kind: 'poster' as const, label: 'A3 Poster', size: 'A3 (297 × 420 mm)', qty: 10 };

test('cards say how many to print: pieces for a standee or cheque, copies for posters and pamphlets', () => {
  assert.equal(copiesText('standee', 1), '1 piece');
  assert.equal(copiesText('poster', 10), '10 copies');
  assert.equal(copiesText('pamphlet', 100), '100 copies');
  assert.equal(copiesText('chequeWinner', 2), '2 pieces');
  assert.equal(specLine({ kind: 'standee', label: 'Standee', size: '6 × 3 ft', qty: 1 }), '6 × 3 ft · 1 piece');
  assert.equal(specLine(poster), 'A3 (297 × 420 mm) · 10 copies');
});

test('a shared file says what it is, its size, the store and how many to print — without nested brackets', () => {
  assert.equal(fileShareText({ kind: 'standee', label: 'Standee', size: '6 × 3 ft', qty: 1 }, 'San Infotech'), 'Standee (6 × 3 ft) — San Infotech — print 1');
  assert.equal(fileShareText(poster, 'San Infotech'), 'A3 Poster (A3, 297 × 420 mm) — San Infotech — print 10');
});

test('the print shop message lists every file with its size, copies and Drive link, and says the files are originals', () => {
  const link = (id: string) => driveView(id);
  const text = printShopText('Subham Infotech', [
    { kind: 'standee', label: 'Standee', size: '6 × 3 ft', qty: 1, link: link('AAA') },
    { ...poster, link: link('BBB') },
  ]);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Print order for Subham Infotech');
  assert.ok(text.includes('1. Standee — 6 × 3 ft — print 1\nhttps://drive.google.com/file/d/AAA/view'));
  assert.ok(text.includes('2. A3 Poster — A3 (297 × 420 mm) — print 10\nhttps://drive.google.com/file/d/BBB/view'));
  assert.match(text, /original files/);
});

test('Drive addresses are built from the file id, which is escaped', () => {
  assert.equal(driveThumb('abc-123_X', 240), 'https://drive.google.com/thumbnail?id=abc-123_X&sz=w240');
  assert.equal(driveThumb('a b'), 'https://drive.google.com/thumbnail?id=a%20b&sz=w400');
  assert.equal(driveView('abc'), 'https://drive.google.com/file/d/abc/view');
});

test('the download name comes from the server header, extended form first', () => {
  assert.equal(dispositionName(`attachment; filename="Subham Infotech - A3 Poster.jpg"; filename*=UTF-8''Subham%20Infotech%20-%20A3%20Poster.jpg`), 'Subham Infotech - A3 Poster.jpg');
  assert.equal(dispositionName('attachment; filename="Waves - Standee.jpg"'), 'Waves - Standee.jpg');
  assert.equal(dispositionName('attachment; filename=plain.pdf'), 'plain.pdf');
  assert.equal(dispositionName(`attachment; filename*=UTF-8''Caf%C3%A9.jpg`), 'Café.jpg');
  assert.equal(dispositionName(null), '');
  assert.equal(dispositionName('inline'), '');
});

test('who saved a file reads as the person and their team', () => {
  assert.equal(downloadedBy('Rhea', 'San Infotech'), 'Rhea (San Infotech team)');
  assert.equal(downloadedBy('', 'San Infotech'), 'San Infotech team');
  assert.equal(downloadedBy('San Infotech', 'San Infotech'), 'San Infotech team');
  assert.equal(downloadedBy('Asha', undefined), 'Asha');
  assert.equal(downloadedBy(undefined, undefined), 'HQ');
});

test('print instructions: the defaults, with HQ’s own size and copies where it set them', () => {
  assert.deepEqual(printRow({}, 'pamphlet'), { kind: 'pamphlet', label: 'A5 Pamphlet', size: 'A5 (148 × 210 mm)', qty: 100 });
  assert.deepEqual(printRow({ printSpec: { poster: { size: 'A2', qty: 4 } } }, 'poster'), { kind: 'poster', label: 'A3 Poster', size: 'A2', qty: 4 });
});
