/**
 * Brand raster renderer — hero.png / hero-dark.png (1720×432, shown at 860w),
 * social-preview.png (1280×640), and the 64px standalone marks that wrap the
 * app icon. Run with `npx electron scripts/render-brand.mjs`.
 *
 * Rasters, not SVG: GitHub sanitizes raster hrefs inside SVGs, so anything that
 * carries the icon bitmap ships as PNG (README guide §7.1). Geometry per §3.2:
 * the wordmark is "Epo" at 236px/800 with −8px tracking; the icon is 1.25× the
 * measured E cap-height with its center on the E midline. Everything is measured
 * with canvas actualBoundingBox* at render time — no hard-coded offsets — so a
 * new icon or font metric shift regenerates cleanly.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'project', 'assets');

const iconB64 = readFileSync(path.join(ASSETS, 'epo_appicon.png')).toString('base64');

const PAGE_SCRIPT = `
(async () => {
  const UI = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${iconB64}'; });

  // Content bounds of the icon bitmap (macOS-style icons carry transparent margins).
  const probe = document.createElement('canvas');
  probe.width = img.naturalWidth; probe.height = img.naturalHeight;
  const pctx = probe.getContext('2d');
  pctx.drawImage(img, 0, 0);
  const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
  let minX = probe.width, minY = probe.height, maxX = 0, maxY = 0;
  for (let y = 0; y < probe.height; y++) {
    for (let x = 0; x < probe.width; x++) {
      if (data[(y * probe.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const box = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  function lockup(ctx, cx, baselineY, fontPx, tracking, textColor) {
    ctx.font = '800 ' + fontPx + 'px ' + UI;
    ctx.letterSpacing = tracking + 'px';
    const e = ctx.measureText('E');
    const capH = e.actualBoundingBoxAscent + e.actualBoundingBoxDescent;
    const m = ctx.measureText('Epo');
    const textW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const iconH = 1.25 * capH;
    const iconW = iconH * (box.w / box.h);
    const gap = fontPx * 0.3;
    const total = iconW + gap + textW;
    const startX = cx - total / 2;
    const iconCenterY = baselineY - capH / 2; // icon center on the E midline (§3.2)
    ctx.drawImage(img, box.x, box.y, box.w, box.h, startX, iconCenterY - iconH / 2, iconW, iconH);
    ctx.fillStyle = textColor;
    ctx.fillText('Epo', startX + iconW + gap + m.actualBoundingBoxLeft, baselineY);
    return { capH, iconH, total };
  }

  function centeredText(ctx, text, cx, y, font, tracking, color) {
    ctx.font = font;
    ctx.letterSpacing = tracking + 'px';
    ctx.fillStyle = color;
    ctx.fillText(text, cx - ctx.measureText(text).width / 2, y);
  }

  function hero(dark) {
    const c = document.createElement('canvas');
    c.width = 1720; c.height = 432;
    const ctx = c.getContext('2d');
    lockup(ctx, 860, 252, 236, -8, dark ? '#eef1f4' : '#1f2328');
    centeredText(ctx, 'Instagram growth on autopilot.', 860, 366,
      '500 38px ' + UI, 0.5, dark ? '#9a9aa2' : '#656d76');
    return c.toDataURL('image/png');
  }

  function social() {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 640;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(640, 180, 60, 640, 180, 900);
    g.addColorStop(0, '#17171b'); g.addColorStop(1, '#0b0b0e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1280, 640);
    lockup(ctx, 640, 306, 150, -5, '#eef1f4');
    centeredText(ctx, 'Instagram growth on autopilot.', 640, 402, '500 30px ' + UI, 0.4, '#9a9aa2');
    centeredText(ctx, 'macOS · Windows · open source (MIT) · local-first', 640, 560,
      '400 18px ' + MONO, 2, '#6a6a72');
    return c.toDataURL('image/png');
  }

  function mark() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    c.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, 128, 128);
    return c.toDataURL('image/png');
  }

  return { heroDark: hero(true), heroLight: hero(false), social: social(), mark: mark() };
})()
`;

function b64(dataUrl) {
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1800, height: 900 });
  await win.loadURL('data:text/html,<html><body></body></html>');
  try {
    const out = await win.webContents.executeJavaScript(PAGE_SCRIPT);
    writeFileSync(path.join(ASSETS, 'hero-dark.png'), b64(out.heroDark));
    writeFileSync(path.join(ASSETS, 'hero.png'), b64(out.heroLight));
    writeFileSync(path.join(ASSETS, 'social-preview.png'), b64(out.social));
    const markSvg = (name) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="Epo">` +
      `<image href="${out.mark}" x="0" y="0" width="64" height="64"/></svg>\n`;
    writeFileSync(path.join(ASSETS, 'epo-mark.svg'), markSvg('epo-mark'));
    writeFileSync(path.join(ASSETS, 'epo-mark-light.svg'), markSvg('epo-mark-light'));
    console.log('wrote hero.png, hero-dark.png, social-preview.png, epo-mark.svg, epo-mark-light.svg');
    app.exit(0);
  } catch (err) {
    console.error('render-brand failed:', err);
    app.exit(1);
  }
});
