// QR codes in the event's look: plain square blocks of ink, like the pixel posters. Error
// correction M is plenty for a code on a projector with nothing drawn over it.
import QRCode from "qrcode";

const INK = "#0D0D0D";

export function pixelQr(text, label = "QR code") {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = modules.size;
  let d = "";
  for (let r = 0; r < n; r += 1) {
    let c = 0;
    while (c < n) {
      if (modules.get(r, c) !== 1) {
        c += 1;
        continue;
      }
      // One rectangle per run of dark blocks keeps the drawing small.
      let end = c;
      while (end < n && modules.get(r, end) === 1) end += 1;
      d += `M${c} ${r}h${end - c}v1h${c - end}z`;
      c = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#F2EEE6"/><path d="${d}" fill="${INK}"/></svg>`;
}
