// frontend/src/components/QrCode.jsx

import { useMemo } from 'react';
import { buildQrMatrix } from '../lib/qr.js';

// Scanners need clear paper around the code; the spec calls for 4 modules, 2 survives
// on screen and buys back space on a narrow receipt.
const QUIET_ZONE = 2;

/** @param {{ value: string, label: string, size?: number }} props */
export function QrCode({ value, label, size = 78 }) {
  const { path, span } = useMemo(() => {
    const { count, modules } = buildQrMatrix(value);
    /** @type {string[]} */
    const cells = [];

    modules.forEach((row, rowIndex) => {
      row.forEach((dark, columnIndex) => {
        if (dark) cells.push(`M${columnIndex + QUIET_ZONE} ${rowIndex + QUIET_ZONE}h1v1h-1z`);
      });
    });

    return { path: cells.join(''), span: count + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
    >
      <rect width={span} height={span} fill="var(--paper)" />
      <path d={path} fill="var(--ink)" shapeRendering="crispEdges" />
    </svg>
  );
}
