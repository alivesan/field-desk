/*
 * QR code → one SVG path. Pure (Node-loadable); the component is src/components/CheckInQr.tsx.
 * Error correction M: survives a smudged print or a glare spot on a TV, still small at ~50 chars.
 */
import qrcode from 'qrcode-generator';

export interface QrShape {
  size: number; // modules per side, quiet zone included
  path: string; // dark modules, one unit square each, already offset by the quiet zone
}

export function qrShape(text: string, quiet = 4): QrShape {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let path = '';
  for (let r = 0; r < n; r++) {
    // run-length per row keeps the path short and avoids hairline seams between modules
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let end = c;
      while (end + 1 < n && qr.isDark(r, end + 1)) end++;
      path += `M${c + quiet} ${r + quiet}h${end - c + 1}v1h${-(end - c + 1)}z`;
      c = end;
    }
  }
  return { size: n + quiet * 2, path };
}
