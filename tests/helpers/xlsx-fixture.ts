import zlib from 'node:zlib';

/*
 * Test helper: a tiny but real .xlsx (a zip of XML parts, deflated), written the way Google Sheets
 * lays it out — shared strings, one worksheet part per tab, and hyperlinks that live only in the
 * sheet's own _rels. Synthetic data only.
 */

export type FixtureCell =
  | string // a plain text cell (shared string)
  | { text: string; link: string } // text with a hyperlink on it (the link is only in the sheet's rels)
  | { inline: string } // an inlineStr cell
  | { formula: string; text: string } // =HYPERLINK("…","…") style: formula text + cached value
  | null;
export interface FixtureSheet {
  name: string;
  rows: [FixtureCell, FixtureCell][];
  /** Leave out the cell references (r="A1") the way some writers do. */
  noRefs?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A stored-or-deflated zip, central directory last. */
export function buildZip(files: { name: string; data: Buffer; stored?: boolean }[]): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.stored ? f.data : zlib.deflateRawSync(f.data);
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    out.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(f.stored ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, cd, end]);
}

export function buildXlsx(sheets: FixtureSheet[]): Buffer {
  const strings: string[] = [];
  const sst = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const files: { name: string; data: Buffer }[] = [];
  const txt = (name: string, s: string) => files.push({ name, data: Buffer.from(s, 'utf8') });

  sheets.forEach((sheet, si) => {
    const links: string[] = [];
    const cell = (col: string, row: number, c: FixtureCell, noRefs?: boolean) => {
      if (c === null || c === '') return '';
      const r = noRefs ? '' : ` r="${col}${row}"`;
      if (typeof c === 'string') return `<c${r} t="s"><v>${sst(c)}</v></c>`;
      if ('inline' in c) return `<c${r} t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`;
      if ('formula' in c) return `<c${r} t="str"><f>${esc(c.formula)}</f><v>${esc(c.text)}</v></c>`;
      links.push(`<hyperlink ref="${col}${row}" r:id="rId${links.length + 1}"/>`);
      return `<c${r} t="s"><v>${sst(c.text)}</v></c>`;
    };
    const rowsXml = sheet.rows
      .map(([a, b], i) => {
        const cells = cell('A', i + 1, a, sheet.noRefs) + cell('B', i + 1, b, sheet.noRefs);
        return cells ? `<row${sheet.noRefs ? '' : ` r="${i + 1}"`}>${cells}</row>` : '';
      })
      .join('');
    const hyper = links.length ? `<hyperlinks>${links.join('')}</hyperlinks>` : '';
    txt(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${rowsXml}</sheetData>${hyper}</worksheet>`);
    if (links.length) {
      const targets = sheet.rows.flatMap(([a, b]) => [a, b]).filter((c): c is { text: string; link: string } => !!c && typeof c === 'object' && 'link' in c);
      txt(
        `xl/worksheets/_rels/sheet${si + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets
          .map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(t.link)}" TargetMode="External"/>`)
          .join('')}</Relationships>`,
      );
    }
  });

  txt('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  txt(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  txt(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  txt('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`);
  return buildZip(files);
}
