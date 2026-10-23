import { useMemo } from 'react';
import { qrShape } from '../lib/qr.ts';
import { cx } from '../lib/util.ts';

/**
 * The player check-in QR as crisp SVG: black on white with a 4-module quiet zone, whatever
 * the page's theme (the venue board is dark — a QR must not be). Scales to its box.
 */
export function CheckInQr({ value, className, title = 'Player check-in QR code' }: { value: string; className?: string; title?: string }) {
  const { size, path } = useMemo(() => qrShape(value), [value]);
  return (
    <svg className={cx('qr', className)} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
