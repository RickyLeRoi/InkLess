// frontend/src/lib/storyImage.js

import { profileUrl } from './instagram.js';
import { buildQrMatrix } from './qr.js';

const CANVAS = { width: 1080, height: 1920 };
const PAPER = { x: 130, width: 820, padding: 60 };
const TEAR = 24;
const QR_TARGET = 190;

const COLORS = {
  page: '#e6e2d8',
  paper: '#f4f2ed',
  ink: '#16150f',
  soft: '#5c584c',
  rule: '#cfcabb'
};

const FONTS = {
  head: '32px "Courier New", Courier, monospace',
  body: '40px "Courier New", Courier, monospace',
  meta: '26px "Courier New", Courier, monospace'
};

const LINE_HEIGHT = 54;

/**
 * Instagram accepts no web intent, so the only honest way onto a story is to hand the
 * OS a finished 1080x1920 PNG. The layout mirrors the CSS receipt on purpose: whatever
 * lands in someone's story has to look like the same object as the one on the board.
 *
 * @param {any} message
 * @returns {HTMLCanvasElement}
 */
export function renderStoryCanvas(message) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS.width;
  canvas.height = CANVAS.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D non disponibile');

  ctx.textBaseline = 'alphabetic';
  ctx.font = FONTS.body;
  const lines = wrapText(ctx, message.text, PAPER.width - PAPER.padding * 2);
  const qr = message.authorInstagram
    ? buildQrMatrix(profileUrl(message.authorInstagram))
    : null;

  const blocks = buildBlocks(ctx, message, lines, qr);
  const paperHeight = PAPER.padding * 2 + blocks.reduce((total, block) => total + block.height, 0);
  const paperY = Math.max(TEAR * 2, Math.round((CANVAS.height - paperHeight) / 2));

  paintPage(ctx);
  paintPaper(ctx, paperY, paperHeight);

  let cursor = paperY + PAPER.padding;
  for (const block of blocks) {
    block.paint(cursor);
    cursor += block.height;
  }

  return canvas;
}

/** @param {any} message */
export function storyImageBlob(message) {
  const canvas = renderStoryCanvas(message);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Export PNG fallito'))),
      'image/png'
    );
  });
}

/**
 * @param {any} message
 * @returns {Promise<'shared' | 'downloaded'>}
 */
export async function shareStoryImage(message) {
  const blob = await storyImageBlob(message);
  const file = new File([blob], `inkless-${message.id}.png`, { type: 'image/png' });

  // On a phone the share sheet is what actually offers Instagram. Desktop browsers have
  // no such sheet, so there the honest fallback is a plain download.
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] });
    return 'shared';
  }

  downloadBlob(blob, file.name);
  return 'downloaded';
}

/**
 * The paper is laid out twice — once to total its height so it can be centred, once to
 * paint. Describing each row as {height, paint} keeps the two passes from drifting.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} message
 * @param {string[]} lines
 * @param {{ count: number, modules: boolean[][] } | null} qr
 * @returns {{ height: number, paint: (top: number) => void }[]}
 */
function buildBlocks(ctx, message, lines, qr) {
  const left = PAPER.x + PAPER.padding;
  const right = PAPER.x + PAPER.width - PAPER.padding;
  const centre = PAPER.x + PAPER.width / 2;

  /** @type {{ height: number, paint: (top: number) => void }[]} */
  const blocks = [];

  blocks.push({
    height: 46,
    paint: (top) => {
      ctx.font = FONTS.head;
      ctx.fillStyle = COLORS.soft;
      drawTracked(ctx, 'INKLESS', centre, top + 32, 7);
    }
  });

  blocks.push(ruleBlock(ctx, left, right));

  for (const line of lines) {
    blocks.push({
      height: LINE_HEIGHT,
      paint: (top) => {
        ctx.font = FONTS.body;
        ctx.fillStyle = COLORS.ink;
        ctx.fillText(line, left, top + 40);
      }
    });
  }

  blocks.push(ruleBlock(ctx, left, right));

  blocks.push({
    height: 44,
    paint: (top) => {
      ctx.font = FONTS.meta;
      ctx.fillStyle = COLORS.soft;
      ctx.fillText(message.author, left, top + 26);
      drawRightAligned(ctx, formatDate(message.createdAt), right, top + 26);
    }
  });

  blocks.push({
    height: 44,
    paint: (top) => {
      ctx.font = FONTS.meta;
      ctx.fillStyle = COLORS.soft;
      ctx.fillText(printCountLabel(message.printCount), left, top + 26);
    }
  });

  if (qr) {
    const cell = Math.max(1, Math.floor(QR_TARGET / qr.count));
    const side = cell * qr.count;
    blocks.push({
      height: side + 60,
      paint: (top) => {
        drawQr(ctx, qr, Math.round(centre - side / 2), top + 20, cell);
      }
    });
  }

  blocks.push(ruleBlock(ctx, left, right));

  blocks.push({
    height: 40,
    paint: (top) => {
      ctx.font = FONTS.meta;
      ctx.fillStyle = COLORS.soft;
      drawTracked(ctx, window.location.host.toUpperCase(), centre, top + 26, 4);
    }
  });

  return blocks;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} left
 * @param {number} right
 */
function ruleBlock(ctx, left, right) {
  return {
    height: 40,
    paint: (/** @type {number} */ top) => {
      ctx.save();
      ctx.strokeStyle = COLORS.rule;
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(left, top + 20);
      ctx.lineTo(right, top + 20);
      ctx.stroke();
      ctx.restore();
    }
  };
}

/** @param {CanvasRenderingContext2D} ctx */
function paintPage(ctx) {
  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, CANVAS.width, CANVAS.height);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} y
 * @param {number} height
 */
function paintPaper(ctx, y, height) {
  const teeth = Math.max(1, Math.round(PAPER.width / TEAR));
  const step = PAPER.width / teeth;
  const right = PAPER.x + PAPER.width;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(PAPER.x, y + TEAR);
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    ctx.lineTo(PAPER.x + step * (tooth + 0.5), y);
    ctx.lineTo(PAPER.x + step * (tooth + 1), y + TEAR);
  }
  ctx.lineTo(right, y + height - TEAR);
  for (let tooth = teeth; tooth > 0; tooth -= 1) {
    ctx.lineTo(PAPER.x + step * (tooth - 0.5), y + height);
    ctx.lineTo(PAPER.x + step * (tooth - 1), y + height - TEAR);
  }
  ctx.closePath();

  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = COLORS.paper;
  ctx.fill();
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ count: number, modules: boolean[][] }} qr
 * @param {number} x
 * @param {number} y
 * @param {number} cell
 */
function drawQr(ctx, qr, x, y, cell) {
  ctx.fillStyle = COLORS.ink;
  qr.modules.forEach((row, rowIndex) => {
    row.forEach((dark, columnIndex) => {
      if (dark) ctx.fillRect(x + columnIndex * cell, y + rowIndex * cell, cell, cell);
    });
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} centreX
 * @param {number} baseline
 * @param {number} tracking
 */
function drawTracked(ctx, text, centreX, baseline, tracking) {
  const chars = [...text];
  const width = chars.reduce((total, char) => total + ctx.measureText(char).width + tracking, 0) - tracking;

  let x = centreX - width / 2;
  for (const char of chars) {
    ctx.fillText(char, x, baseline);
    x += ctx.measureText(char).width + tracking;
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} right
 * @param {number} baseline
 */
function drawRightAligned(ctx, text, right, baseline) {
  ctx.fillText(text, right - ctx.measureText(text).width, baseline);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapText(ctx, text, maxWidth) {
  /** @type {string[]} */
  const lines = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean).flatMap((word) => splitOverlong(ctx, word, maxWidth));
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }

  return lines;
}

/**
 * A 200-character message can legitimately be one unbroken token (a URL, a keysmash).
 * Word wrapping alone would let it run off the paper, so it gets cut by force.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} word
 * @param {number} maxWidth
 * @returns {string[]}
 */
function splitOverlong(ctx, word, maxWidth) {
  if (ctx.measureText(word).width <= maxWidth) return [word];

  /** @type {string[]} */
  const chunks = [];
  let current = '';

  for (const char of word) {
    if (current && ctx.measureText(current + char).width > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/** @param {number} count */
function printCountLabel(count) {
  return `Stampato ${count} ${count === 1 ? 'volta' : 'volte'}`;
}

/** @param {string} createdAt */
function formatDate(createdAt) {
  return new Date(createdAt).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
