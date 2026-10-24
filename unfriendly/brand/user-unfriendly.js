/*
  USER UNFRIENDLY: the pixel effects, drawn in code so they stay sharp at any size.

  pixelText() sets a title a few dozen pixels wide on a <canvas class="uu-pixels">, and the browser blows it up
  block by block. Left soft, the type's own edges turn into greys (Nawfal's launch poster); with crisp: true
  every block is ink or paper (the agenda posters). dither() draws the red pixel edge that runs into the slab.
  Nothing here moves.

  import { fontsReady, pixelText, dither } from "./user-unfriendly.js";
*/

export const RED = "#E5231B", INK = "#0D0D0D", PAPER = "#F2EEE6";

// Pixels made before Archivo arrives would be the fallback font's letters, so wait for it.
export async function fontsReady() {
  try {
    await Promise.all([document.fonts.load('900 100px "Archivo"'), document.fonts.load('16px "DM Mono"')]);
  } catch {
    // Draw with whatever is there rather than nothing.
  }
}

function setFont(ctx, px, stretch = "extra-condensed") {
  ctx.font = `900 ${px}px "Archivo"`;
  if ("fontStretch" in ctx) ctx.fontStretch = stretch;
}

/*
  Draws lines of capitals into a canvas `cols` pixels wide. Lines whose index is in `spread` are stretched
  sideways to fill the width, letters wide and close together (USER on the launch poster); the other lines
  decide the type size.
  Returns every letter's box as fractions of the canvas ({ x, y, w, h }), for placing tracking boxes on top.
  `stretch` is a canvas width keyword ("condensed" is wider); `tall` stretches the letters upwards, 1.35 for the
  launch poster's tall letters.
*/
export function pixelText(canvas, { lines, cols = 60, spread = [], color = INK, background = PAPER, gap = 0.3, crisp = false, stretch = "extra-condensed", tall = 1 } = {}) {
  const ctx = canvas.getContext("2d", { willReadFrequently: crisp });
  setFont(ctx, 100, stretch);
  const sizers = lines.filter((_, i) => !spread.includes(i));
  const widest = Math.max(...(sizers.length ? sizers : lines).map((line) => ctx.measureText(line).width));
  const px = (100 * (cols - 2)) / widest;
  setFont(ctx, px, stretch);
  const cap = ctx.measureText("H").actualBoundingBoxAscent * tall;
  const lead = cap * gap;
  canvas.width = cols;
  canvas.height = Math.ceil(lines.length * cap + (lines.length - 1) * lead) + 2;
  const rows = canvas.height;

  setFont(ctx, px, stretch); // resizing a canvas resets its font
  ctx.clearRect(0, 0, cols, rows);
  ctx.fillStyle = crisp ? "#000" : color;
  if (!crisp) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cols, rows);
    ctx.fillStyle = color;
  }

  const boxes = lines.map((line, i) => {
    const base = 1 + cap * (i + 1) + lead * i;
    const chars = [...line];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const draw = (text, x, wide = 1) => {
      ctx.save();
      ctx.translate(x, base);
      ctx.scale(wide, tall);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    const out = [];
    if (spread.includes(i)) {
      const wide = (cols - 2) / ctx.measureText(line).width;
      draw(line, 1, wide);
      chars.forEach((c, k) => {
        const x = 1 + ctx.measureText(line.slice(0, k)).width * wide;
        out.push({ x: x / cols, y: (base - cap) / rows, w: (widths[k] * wide) / cols, h: cap / rows });
      });
    } else {
      const x0 = (cols - ctx.measureText(line).width) / 2;
      draw(line, x0);
      chars.forEach((c, k) => {
        const x = x0 + ctx.measureText(line.slice(0, k)).width;
        out.push({ x: x / cols, y: (base - cap) / rows, w: widths[k] / cols, h: cap / rows });
      });
    }
    return out;
  });

  if (crisp) {
    const { data } = ctx.getImageData(0, 0, cols, rows);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cols, rows);
    ctx.fillStyle = color;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) if (data[(y * cols + x) * 4 + 3] >= 128) ctx.fillRect(x, y, 1, 1);
    }
  }
  return boxes;
}

/*
  The launch poster's mosaic, done the way it was made: a word set at full size, then shrunk to a few dozen
  blocks, each block's grey being how much of it the letter covers. Stretch the canvas afterwards (CSS
  aspect-ratio) and the blocks stretch too, like USER on the poster. fitSize() gives the size that fits a word
  into `cols` blocks, so two words can share one size. Returns each letter's box as fractions of the canvas.
*/
export function fitSize(text, cols, stretch = "extra-condensed", track = 0) {
  const ctx = document.createElement("canvas").getContext("2d");
  setFont(ctx, 100, stretch);
  const width = [...text].reduce((sum, c) => sum + ctx.measureText(c).width, 0) + track * 100 * (text.length - 1);
  return (100 * cols) / width;
}

export function pixelWord(canvas, text, { size, tall = 1, stretch = "extra-condensed", color = INK, background = PAPER, detail = 8, soften = 0, track = 0 } = {}) {
  const probe = document.createElement("canvas").getContext("2d");
  setFont(probe, size, stretch);
  // `track` adds space between letters, in em
  const chars = [...text];
  const widths = chars.map((c) => probe.measureText(c).width);
  const starts = widths.map((_, k) => widths.slice(0, k).reduce((a, b) => a + b, 0) + track * size * k);
  const width = starts.at(-1) + widths.at(-1);
  const cap = probe.measureText("H").actualBoundingBoxAscent * tall;
  const cols = Math.max(1, Math.round(width));
  const rows = Math.ceil(cap + 0.6);

  // Set the word `detail` times bigger, transparent everywhere but the letters
  const big = document.createElement("canvas");
  big.width = cols * detail;
  big.height = rows * detail;
  const b = big.getContext("2d", { willReadFrequently: true });
  setFont(b, size * detail, stretch);
  // `soften` blurs the letters (in blocks) before they're shrunk, for the poster's soft greys
  if (soften) b.filter = `blur(${soften * detail}px)`;
  b.save();
  b.translate(0, cap * detail);
  b.scale(cols / width, tall);
  chars.forEach((c, k) => b.fillText(c, starts[k] * detail, 0));
  b.restore();
  const { data } = b.getImageData(0, 0, big.width, big.height);

  // Shrink it by averaging: each block mixes paper and ink by how much letter it holds
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(cols, rows);
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [bg, fg] = [hex(background), hex(color)];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let dy = 0; dy < detail; dy++) {
        for (let dx = 0; dx < detail; dx++) sum += data[((y * detail + dy) * big.width + x * detail + dx) * 4 + 3];
      }
      const cover = sum / (255 * detail * detail);
      const i = (y * cols + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(bg[c] + (fg[c] - bg[c]) * cover);
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const sx = cols / width;
  return chars.map((_, k) => ({ x: (starts[k] * sx) / cols, y: 0, w: (widths[k] * sx) / cols, h: cap / rows }));
}

/*
  The pixel edge into the slab: sparse at the top, solid at the bottom. The canvas is transparent where it
  isn't red, so whatever sits behind it shows through. The same seed always draws the same edge.
*/
export function dither(canvas, { cols = 200, rows = 18, color = RED, seed = 27 } = {}) {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cols, rows);
  ctx.fillStyle = color;
  let s = seed >>> 0;
  const random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let y = 0; y < rows; y++) {
    const p = y === rows - 1 ? 1 : ((y + 1) / rows) ** 1.7;
    for (let x = 0; x < cols; x++) if (random() < p) ctx.fillRect(x, y, 1, 1);
  }
}
