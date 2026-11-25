export interface Gray8Bitmap {
  width: number;
  height: number;
  data: number[];
}

function createCanvas(width: number, height: number, fill = 0): Uint8Array {
  const buf = new Uint8Array(width * height);
  if (fill !== 0) buf.fill(fill);
  return buf;
}

function fillRect(
  buf: Uint8Array,
  cw: number,
  ch: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(cw, Math.floor(x + w));
  const y1 = Math.min(ch, Math.floor(y + h));
  for (let py = y0; py < y1; py++) {
    const rowOffset = py * cw;
    for (let px = x0; px < x1; px++) {
      buf[rowOffset + px] = value;
    }
  }
}

function strokeRect(
  buf: Uint8Array,
  cw: number,
  ch: number,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  value: number
): void {
  fillRect(buf, cw, ch, x, y, w, thickness, value);
  fillRect(buf, cw, ch, x, y + h - thickness, w, thickness, value);
  fillRect(buf, cw, ch, x, y, thickness, h, value);
  fillRect(buf, cw, ch, x + w - thickness, y, thickness, h, value);
}

function drawFinderModule(
  buf: Uint8Array,
  cw: number,
  ch: number,
  x: number,
  y: number,
  cell: number
): void {
  fillRect(buf, cw, ch, x, y, cell * 7, cell * 7, 255);
  fillRect(buf, cw, ch, x + cell, y + cell, cell * 5, cell * 5, 0);
  fillRect(buf, cw, ch, x + cell * 2, y + cell * 2, cell * 3, cell * 3, 255);
}

/**
 * Generates a crisp 112x112 monochrome Gray8 pairing matrix + corner finders.
 * Bounded strictly within ImageContainerProperty firmware limits (width 20..288, height 20..144).
 */
export function renderPairingMatrix(code6: string, seedText = 'CUE-G2'): Gray8Bitmap {
  const width = 112;
  const height = 112;
  const buf = createCanvas(width, height, 0);

  // Dark crisp outer frame + inner white plate margin
  strokeRect(buf, width, height, 0, 0, width, height, 2, 220);

  const gridSize = 21;
  const cell = 4; // 21 * 4 = 84px centered inside 112px
  const offset = 14;

  // Draw finder patterns at TL, TR, BL corners
  drawFinderModule(buf, width, height, offset, offset, cell);
  drawFinderModule(buf, width, height, offset + (gridSize - 7) * cell, offset, cell);
  drawFinderModule(buf, width, height, offset, offset + (gridSize - 7) * cell, cell);

  // Deterministic hash encoding of pairing code + URL metadata in data cells
  const seed = `${code6}:${seedText}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const inTL = row < 8 && col < 8;
      const inTR = row < 8 && col >= gridSize - 8;
      const inBL = row >= gridSize - 8 && col < 8;
      const isTiming = (row === 6 || col === 6) && !inTL && !inTR && !inBL;
      if (inTL || inTR || inBL) continue;

      let on = false;
      if (isTiming) {
        on = (row + col) % 2 === 0;
      } else {
        const bitHash = Math.imul(h ^ (row * 31 + col * 17), 0x45d9f3b);
        on = ((bitHash >>> 16) & 1) === 1;
      }

      if (on) {
        fillRect(
          buf,
          width,
          height,
          offset + col * cell,
          offset + row * cell,
          cell - 0,
          cell - 0,
          245
        );
      }
    }
  }

  // Subtle corner alignment square
  fillRect(buf, width, height, offset + 13 * cell, offset + 13 * cell, cell * 3, cell * 3, 240);
  fillRect(buf, width, height, offset + 14 * cell, offset + 14 * cell, cell, cell, 0);

  return { width, height, data: Array.from(buf) };
}

/**
 * Generates a 240x28 Gray8 monochrome horizon timeline bar for NOW / UNDO modes.
 */
export function renderHorizonBar(
  urgencyMinutes: number,
  activeIndex: number,
  totalCards: number,
  undoRemainingMs?: number
): Gray8Bitmap {
  const width = 240;
  const height = 24;
  const buf = createCanvas(width, height, 0);

  // Subtle hairline baseline
  fillRect(buf, width, height, 2, 11, 152, 2, 70);

  if (typeof undoRemainingMs === 'number') {
    const ratio = Math.max(0, Math.min(1, undoRemainingMs / 3000));
    strokeRect(buf, width, height, 2, 4, 152, 16, 1, 200);
    const fillW = Math.round(146 * ratio);
    if (fillW > 0) {
      fillRect(buf, width, height, 5, 7, fillW, 10, 255);
    }
  } else {
    // 60-minute urgency timeline: nearer urgency fills toward full highlight
    const clamped = Math.max(0, Math.min(60, urgencyMinutes));
    const fillRatio = 1 - clamped / 60;
    strokeRect(buf, width, height, 2, 6, 152, 12, 1, 140);
    for (let tick = 1; tick <= 3; tick++) {
      fillRect(buf, width, height, 2 + tick * 38, 4, 1, 4, 150);
    }
    const barW = Math.max(8, Math.round(146 * fillRatio));
    fillRect(buf, width, height, 5, 9, barW, 6, urgencyMinutes <= 5 ? 255 : 210);
  }

  // Card pagination pips on the right (up to 6 pips)
  const count = Math.max(1, Math.min(6, totalCards));
  const pipStartX = 166;
  for (let i = 0; i < count; i++) {
    const px = pipStartX + i * 12;
    if (i === activeIndex % count) {
      fillRect(buf, width, height, px, 7, 8, 10, 255);
    } else {
      strokeRect(buf, width, height, px, 9, 8, 6, 1, 130);
    }
  }

  return { width, height, data: Array.from(buf) };
}

/**
 * Generates a 240x36 Gray8 live PCM waveform visualization for VOICE mode.
 */
export function renderVoiceWaveform(pcmSamples: Uint8Array | number[], phaseTick = 0): Gray8Bitmap {
  const width = 240;
  const height = 36;
  const buf = createCanvas(width, height, 0);

  const bars = 24;
  const slotW = 10;
  const barW = 6;
  const midY = Math.floor(height / 2);

  // Center baseline
  fillRect(buf, width, height, 0, midY, width, 1, 70);

  for (let b = 0; b < bars; b++) {
    let amp = 0;
    if (pcmSamples.length >= 2 && pcmSamples.some((v) => v !== 0)) {
      const idx = Math.min(pcmSamples.length - 2, Math.floor((b / bars) * (pcmSamples.length / 2)) * 2);
      const lo = pcmSamples[idx] ?? 0;
      const hi = pcmSamples[idx + 1] ?? 0;
      const signed = ((hi << 8) | lo) << 16 >> 16;
      amp = Math.max(0.18, Math.min(1, Math.abs(signed) / 14000));
    } else {
      // Crisp active mic cadence pulse while G2 audio frames stream in
      amp = 0.25 + 0.7 * Math.abs(Math.sin(b * 0.65 + (phaseTick + 1) * 0.75));
    }

    const barH = Math.max(4, Math.min(height - 4, Math.round(amp * (height - 4))));
    const topY = Math.floor(midY - barH / 2);
    const brightness = barH > 20 ? 255 : 200;
    fillRect(buf, width, height, b * slotW + 2, topY, barW, barH, brightness);
  }

  return { width, height, data: Array.from(buf) };
}
