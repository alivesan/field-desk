/**
 * Burns a proof stamp into the photo: a band under the image with store, label,
 * time and GPS. The band is added below the picture so it never covers what was photographed.
 */
export async function stampPhoto(file: Blob, meta: { title: string; label: string; time: string; place: string; ref: string }): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const f = Math.max(15, Math.round(w * 0.024));
  const padX = Math.round(f * 1.1);
  const band = Math.round(f * 5.4);

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h + band;
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  g.fillStyle = '#141311';
  g.fillRect(0, h, w, band);
  g.fillStyle = '#C8361D';
  g.fillRect(0, h, Math.round(f * 0.35), band);

  const mono = (size: number, weight = 400) => `${weight} ${size}px "Geist Mono", ui-monospace, Menlo, monospace`;
  const line = (y: number) => h + Math.round(f * y);
  const max = w - padX * 2;

  g.textBaseline = 'alphabetic';
  g.fillStyle = '#F3F0E8';
  g.font = mono(f, 500);
  g.fillText(fit(g, `${meta.title.toUpperCase()} · ${meta.label}`, max * 0.78), padX, line(1.6));

  g.font = mono(Math.round(f * 0.86));
  g.fillStyle = '#CFCAC0';
  g.fillText(fit(g, meta.time, max), padX, line(2.95));
  g.fillText(fit(g, meta.place, max), padX, line(4.2));

  g.textAlign = 'right';
  g.fillStyle = '#8D877C';
  g.font = mono(Math.round(f * 0.7));
  g.fillText(`FIELD DESK · ${meta.ref.toUpperCase()}`, w - padX, line(1.6));

  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode photo'))), 'image/jpeg', 0.85));
}

function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 4 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}
