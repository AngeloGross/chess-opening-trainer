// QR code for "Send to phone" (slice 8): the vendored qrcode-generator turned into one SVG path.
import { qrcode } from '../vendor/qrcode-generator@2.0.4/dist/qrcode.mjs';

/**
 * Smallest QR code (byte mode, error correction L) for `text`, as an SVG path of its dark modules.
 * Throws if the text does not fit version 40 (2,953 bytes).
 * @param {string} text  ASCII (a URL)
 * @returns {{version: number, modules: number, path: string}}
 */
export function qrPath(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let path = '';
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!qr.isDark(r, c)) continue;
      let run = 1; // one rectangle per horizontal run of dark modules keeps the path short
      while (c + run < n && qr.isDark(r, c + run)) run += 1;
      path += `M${c} ${r}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return { version: (n - 17) / 4, modules: n, path };
}

/**
 * The QR code as an SVG element string with a 4-module quiet zone, scaled by CSS.
 * @param {string} text @param {string} [label]
 */
export function qrSvg(text, label = 'QR code') {
  const { modules, path } = qrPath(text);
  const size = modules + 8;
  const esc = label.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${esc}">`
    + `<rect x="-4" y="-4" width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
