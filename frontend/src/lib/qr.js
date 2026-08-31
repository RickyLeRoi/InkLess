// frontend/src/lib/qr.js

import qrcode from 'qrcode-generator';

// Level M keeps scanning from a phone held at arm's length while staying small enough
// that the code does not dominate a 22rem receipt.
const ERROR_CORRECTION = 'M';
// 0 lets the encoder pick the smallest version that fits the URL.
const AUTO_VERSION = 0;

/**
 * @param {string} value
 * @returns {{ count: number, modules: boolean[][] }}
 */
export function buildQrMatrix(value) {
  const qr = qrcode(AUTO_VERSION, ERROR_CORRECTION);
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const modules = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => qr.isDark(row, column))
  );

  return { count, modules };
}
