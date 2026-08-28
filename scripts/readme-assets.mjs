/**
 * README static-asset generator — buttons, section-header plates, feature-icon
 * tiles, the growth-loop diagram, and the footer divider under `project/assets/`.
 *
 * The geometry and palette follow docs/README-GUIDE §3 (brand rules) and §6
 * (maintenance playbook) exactly; regenerate with `node scripts/readme-assets.mjs`
 * after changing a title, icon, or chip label. Deterministic: same inputs, same
 * bytes. Feature icons wrap Font Awesome Free 6 solid glyphs (CC BY 4.0) read
 * pristine from scripts/fa6/ — never hand-drawn (§3.6).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'project', 'assets');
const FA6 = path.join(ROOT, 'scripts', 'fa6');

const UI_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
const MONO_FONT = `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;

// §3.4 — self-lit plate palette (theme-independent assets).
const PLATE = { top: '#202025', bot: '#161619', stroke: '#33333a', text: '#d8dde3' };
const BTN_PRIMARY = { top: '#26262c', bot: '#17171b', stroke: '#45454e', text: '#eef1f4' };
const BTN_SECONDARY = { top: '#1d1d22', bot: '#16161a', stroke: '#33333a', text: '#d8dde3' };
const ICON_GRAY = '#868d96';
const HIGHLIGHT = 'rgba(255,255,255,0.05)';

function write(rel, svg) {
  const file = path.join(OUT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, svg);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

/** Vertical plate gradient + 1px inner top highlight, shared by every graphite face. */
function plateDefs(id, top, bot) {
  return (
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bot}"/>` +
    `</linearGradient>`
  );
}

function plateRect(x, y, w, h, r, gradId, stroke) {
  return (
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="url(#${gradId})" stroke="${stroke}"/>` +
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" rx="${r - 1}" fill="none" stroke="${HIGHLIGHT}"/>`
  );
}

// --- Section-header plates (§6: 54h; textLength = round(len × 10.6); plate width =
// --- 24 + textLength + 24; total = plate + 2×(44 + 12) for the flanking fade rules).
const HEADERS = {
  features: 'FEATURES',
  'how-it-works': 'HOW IT WORKS',
  autopilot: 'A DAY ON AUTOPILOT',
  safety: 'SAFETY LIMITS',
  'getting-started': 'GETTING STARTED',
  settings: 'SETTINGS',
  faq: 'FAQ',
  compatibility: 'COMPATIBILITY',
  developers: 'FOR DEVELOPERS',
};

function headerSvg(title) {
  const textLength = Math.round(title.length * 10.6);
  const plateW = 24 + textLength + 24;
  const totalW = plateW + 2 * (44 + 12);
  const plateX = 44 + 12;
  const H = 54;
  const midY = H / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}" role="img" aria-label="${title}">` +
    `<defs>${plateDefs('p', PLATE.top, PLATE.bot)}` +
    `<linearGradient id="rl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PLATE.stroke}" stop-opacity="0"/><stop offset="1" stop-color="#3a3a41"/></linearGradient>` +
    `<linearGradient id="rr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3a41"/><stop offset="1" stop-color="${PLATE.stroke}" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect x="0" y="${midY - 0.5}" width="44" height="1" fill="url(#rl)"/>` +
    `<rect x="${totalW - 44}" y="${midY - 0.5}" width="44" height="1" fill="url(#rr)"/>` +
    plateRect(plateX, 9, plateW, 36, 9, 'p', PLATE.stroke) +
    `<text x="${totalW / 2}" y="${midY + 4.5}" text-anchor="middle" font-family="${UI_FONT}" font-size="12.5" font-weight="700" letter-spacing="3" fill="${PLATE.text}" textLength="${textLength}" lengthAdjust="spacing">${title}</text>` +
    `</svg>\n`
  );
}

// --- Buttons (46h graphite plates; §2 file inventory) ---

function downloadButton() {
  const W = 300;
  const label = 'Download for macOS / Windows';
  const textLength = 214;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="46" viewBox="0 0 ${W} 46" role="img" aria-label="${label}">` +
    `<defs>${plateDefs('p', BTN_PRIMARY.top, BTN_PRIMARY.bot)}</defs>` +
    plateRect(0, 0, W, 46, 9, 'p', BTN_PRIMARY.stroke) +
    `<g stroke="${BTN_PRIMARY.text}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
    `<path d="M33 14.5v11.5"/><path d="M27.5 20.5 33 26l5.5-5.5"/><path d="M25.5 31h15"/>` +
    `</g>` +
    `<text x="165" y="27.9" text-anchor="middle" font-family="${UI_FONT}" font-size="13.5" font-weight="600" letter-spacing="0.5" fill="${BTN_PRIMARY.text}" textLength="${textLength}" lengthAdjust="spacing">${label}</text>` +
    `</svg>\n`
  );
}

function releasesButton() {
  const W = 160;
  const label = 'All releases';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="46" viewBox="0 0 ${W} 46" role="img" aria-label="${label}">` +
    `<defs>${plateDefs('p', BTN_SECONDARY.top, BTN_SECONDARY.bot)}</defs>` +
    plateRect(0, 0, W, 46, 9, 'p', BTN_SECONDARY.stroke) +
    `<text x="${W / 2}" y="27.9" text-anchor="middle" font-family="${UI_FONT}" font-size="13.5" font-weight="600" letter-spacing="0.5" fill="${BTN_SECONDARY.text}" textLength="92" lengthAdjust="spacing">${label}</text>` +
    `</svg>\n`
  );
}

// --- Feature icons (§3.6: FA6 solid path in a 30px box centered in a 40px tile) ---

const ICONS = {
  local: 'house-lock',
  pace: 'gauge',
  sentinel: 'shield-halved',
  reconcile: 'user-shield',
  resume: 'bookmark',
  console: 'terminal',
};

function iconSvg(faName) {
  const src = readFileSync(path.join(FA6, `${faName}.svg`), 'utf8');
  const vb = src.match(/viewBox="0 0 (\d+) (\d+)"/);
  const d = src.match(/<path d="([^"]+)"/);
  const comment = src.match(/<!--!([\s\S]*?)-->/);
  if (!vb || !d || !comment) throw new Error(`unparseable FA6 source: ${faName}.svg`);
  const [w, h] = [Number(vb[1]), Number(vb[2])];
  const s = 30 / Math.max(w, h);
  const tx = (40 - w * s) / 2;
  const ty = (40 - h * s) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
    `<!--!${comment[1]}-->` +
    `<path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})" fill="${ICON_GRAY}" d="${d[1]}"/>` +
    `</svg>\n`
  );
}

// --- Growth-loop diagram (§6: 58h chips r10, mono number over 12.5/600 label;
// --- top row 4 chips L→R, bottom row 3 chips R→L, 1.5px triangle-marker arrows,
// --- return arrow around the left edge back to chip 01; both themes, one geometry) ---

const LOOP_CHIPS = [
  { n: '01', label: 'Pick a seed' },
  { n: '02', label: 'Read followers' },
  { n: '03', label: 'Choose' },
  { n: '04', label: 'Follow' },
  { n: '05', label: 'Watch follow-backs' },
  { n: '06', label: 'Unfollow' },
  { n: '07', label: 'Next target' },
];

function loopSvg(dark) {
  const c = dark
    ? { top: PLATE.top, bot: PLATE.bot, stroke: PLATE.stroke, num: '#66666e', label: '#d8dde3', arrow: '#55555e', hi: HIGHLIGHT }
    : { top: '#fbfcfd', bot: '#eef0f3', stroke: '#d0d7de', num: '#8c959f', label: '#1f2328', arrow: '#8c959f', hi: 'rgba(255,255,255,0.6)' };
  const W = 820;
  const H = 250;
  const CH = 58;
  const topY = 20;
  const botY = 172;
  // Top row: 4 × 160w chips, 24 gaps, x from 68 (the left lane holds the return arrow).
  const topXs = [68, 252, 436, 620];
  const TW = 160;
  // Bottom row: 3 × 190w chips right-aligned with the top row's right edge (780).
  const botXs = [162, 376, 590];
  const BW = 190;

  const chip = (x, y, w, { n, label }) =>
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${CH - 1}" rx="10" fill="url(#chip)" stroke="${c.stroke}"/>` +
    `<rect x="${x + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${CH - 3}" rx="9" fill="none" stroke="${c.hi}"/>` +
    `<text x="${x + w / 2}" y="${y + 24}" text-anchor="middle" font-family="${MONO_FONT}" font-size="10" letter-spacing="2.5" fill="${c.num}">${n}</text>` +
    `<text x="${x + w / 2}" y="${y + 42.5}" text-anchor="middle" font-family="${UI_FONT}" font-size="12.5" font-weight="600" fill="${c.label}">${label}</text>`;

  const arrow = (x1, y1, x2, y2) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${c.arrow}" stroke-width="1.5" marker-end="url(#tri)"/>`;

  let body = '';
  topXs.forEach((x, i) => {
    body += chip(x, topY, TW, LOOP_CHIPS[i]);
  });
  botXs.forEach((x, i) => {
    body += chip(x, botY, BW, LOOP_CHIPS[6 - i]); // 07, 06, 05 left→right
  });
  const midTop = topY + CH / 2; // 49
  const midBot = botY + CH / 2; // 201
  for (let i = 0; i < 3; i++) body += arrow(topXs[i] + TW + 3, midTop, topXs[i + 1] - 6, midTop);
  // 04 → 05: drop from the top row into the bottom row.
  body += arrow(700, topY + CH + 3, 700, botY - 6);
  // Bottom row flows right → left: 05 → 06 → 07.
  body += arrow(botXs[2] - 3, midBot, botXs[1] + BW + 6, midBot);
  body += arrow(botXs[1] - 3, midBot, botXs[0] + BW + 6, midBot);
  // Return: 07 around the left edge back into 01.
  body +=
    `<path d="M${botXs[0] - 3} ${midBot} L30 ${midBot} L30 ${midTop} L${topXs[0] - 6} ${midTop}"` +
    ` fill="none" stroke="${c.arrow}" stroke-width="1.5" stroke-linejoin="round" marker-end="url(#tri)"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="The Epo growth loop">` +
    `<defs>${plateDefs('chip', c.top, c.bot)}` +
    `<marker id="tri" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0.5 0.5 L7.5 4 L0.5 7.5 z" fill="${c.arrow}"/></marker></defs>` +
    body +
    `</svg>\n`
  );
}

// --- Footer divider (22h: fading rules flanking a rounded-square motif) ---

function dividerSvg() {
  const W = 240;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="22" viewBox="0 0 ${W} 22">` +
    `<defs>` +
    `<linearGradient id="dl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3a41" stop-opacity="0"/><stop offset="1" stop-color="#3a3a41"/></linearGradient>` +
    `<linearGradient id="dr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3a41"/><stop offset="1" stop-color="#3a3a41" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect x="2" y="10.5" width="94" height="1" fill="url(#dl)"/>` +
    `<rect x="${W - 96}" y="10.5" width="94" height="1" fill="url(#dr)"/>` +
    `<rect x="114.5" y="5.5" width="11" height="11" rx="3.5" fill="none" stroke="#4a4a52" stroke-width="1.2"/>` +
    `</svg>\n`
  );
}

// --- Release cards (docs/RELEASE.md §4: Epo plate language, Mental's structure;
// --- pure vector — GitHub strips raster hrefs inside SVGs, so no icon bitmap).

/** 860×120 release banner, stamped with the version from package.json. */
function releaseBannerSvg(version) {
  const W = 860;
  const H = 120;
  const midY = H / 2;
  const sub = `v${version} · INSTAGRAM GROWTH ON AUTOPILOT`;
  const subLength = Math.round(sub.length * 7.4);
  let ticks = '';
  for (let i = 1; i < 12; i++) {
    const x = (W / 12) * i;
    ticks +=
      `<line x1="${x}" y1="1.5" x2="${x}" y2="7.5" stroke="${PLATE.stroke}"/>` +
      `<line x1="${x}" y1="${H - 1.5}" x2="${x}" y2="${H - 7.5}" stroke="${PLATE.stroke}"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Epo v${version}">` +
    `<defs>${plateDefs('p', PLATE.top, PLATE.bot)}` +
    `<linearGradient id="rl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PLATE.stroke}" stop-opacity="0"/><stop offset="1" stop-color="#3a3a41"/></linearGradient>` +
    `<linearGradient id="rr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3a41"/><stop offset="1" stop-color="${PLATE.stroke}" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    plateRect(0, 0, W, H, 12, 'p', PLATE.stroke) +
    ticks +
    `<rect x="40" y="${midY - 0.5}" width="130" height="1" fill="url(#rl)"/>` +
    `<rect x="${W - 170}" y="${midY - 0.5}" width="130" height="1" fill="url(#rr)"/>` +
    `<text x="${W / 2}" y="57" text-anchor="middle" font-family="${UI_FONT}" font-size="30" font-weight="800" letter-spacing="8" fill="#eef1f4" textLength="76" lengthAdjust="spacing">EPO</text>` +
    `<text x="${W / 2}" y="84" text-anchor="middle" font-family="${MONO_FONT}" font-size="11" letter-spacing="2.5" fill="#9a9aa2" textLength="${subLength}" lengthAdjust="spacing">${sub}</text>` +
    `</svg>\n`
  );
}

// Per-release download buttons (46h, the README download button's recipe) —
// each links straight to one asset on the release page, so users click a
// plate instead of hunting through the asset list.
const RELEASE_BUTTONS = {
  'mac-arm64': 'macOS · Apple silicon',
  'mac-x64': 'macOS · Intel',
  windows: 'Windows',
};

function releaseButtonSvg(label) {
  const textLength = Math.round(label.length * 7.65);
  const W = 24 + 18 + 12 + textLength + 24;
  const textMid = 54 + (W - 24 - 54) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="46" viewBox="0 0 ${W} 46" role="img" aria-label="Download for ${label}">` +
    `<defs>${plateDefs('p', BTN_PRIMARY.top, BTN_PRIMARY.bot)}</defs>` +
    plateRect(0, 0, W, 46, 9, 'p', BTN_PRIMARY.stroke) +
    `<g stroke="${BTN_PRIMARY.text}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
    `<path d="M33 14.5v11.5"/><path d="M27.5 20.5 33 26l5.5-5.5"/><path d="M25.5 31h15"/>` +
    `</g>` +
    `<text x="${textMid}" y="27.9" text-anchor="middle" font-family="${UI_FONT}" font-size="13.5" font-weight="600" letter-spacing="0.5" fill="${BTN_PRIMARY.text}" textLength="${textLength}" lengthAdjust="spacing">${label}</text>` +
    `</svg>\n`
  );
}

// 42h section plates for release bodies — the README's 54h plate formula, scaled.
const RELEASE_HEADERS = {
  highlights: 'HIGHLIGHTS',
  changes: 'CHANGES',
  install: 'INSTALL',
  notes: 'NOTES',
};

function releaseHeaderSvg(title) {
  const textLength = Math.round(title.length * 8.9);
  const plateW = 18 + textLength + 18;
  const totalW = plateW + 2 * (34 + 10);
  const plateX = 34 + 10;
  const H = 42;
  const midY = H / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}" role="img" aria-label="${title}">` +
    `<defs>${plateDefs('p', PLATE.top, PLATE.bot)}` +
    `<linearGradient id="rl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${PLATE.stroke}" stop-opacity="0"/><stop offset="1" stop-color="#3a3a41"/></linearGradient>` +
    `<linearGradient id="rr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3a41"/><stop offset="1" stop-color="${PLATE.stroke}" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect x="0" y="${midY - 0.5}" width="34" height="1" fill="url(#rl)"/>` +
    `<rect x="${totalW - 34}" y="${midY - 0.5}" width="34" height="1" fill="url(#rr)"/>` +
    plateRect(plateX, 7, plateW, 28, 7, 'p', PLATE.stroke) +
    `<text x="${totalW / 2}" y="${midY + 3.8}" text-anchor="middle" font-family="${UI_FONT}" font-size="10.5" font-weight="700" letter-spacing="2.5" fill="${PLATE.text}" textLength="${textLength}" lengthAdjust="spacing">${title}</text>` +
    `</svg>\n`
  );
}

// --- Emit everything ---

const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

for (const [name, title] of Object.entries(HEADERS)) write(`headers/${name}.svg`, headerSvg(title));
write('buttons/download.svg', downloadButton());
write('buttons/releases.svg', releasesButton());
for (const [name, fa] of Object.entries(ICONS)) write(`icons/${name}.svg`, iconSvg(fa));
write('diagrams/loop-dark.svg', loopSvg(true));
write('diagrams/loop.svg', loopSvg(false));
write('divider.svg', dividerSvg());
write('release/banner.svg', releaseBannerSvg(VERSION));
for (const [name, title] of Object.entries(RELEASE_HEADERS))
  write(`release/headers/${name}.svg`, releaseHeaderSvg(title));
for (const [name, label] of Object.entries(RELEASE_BUTTONS))
  write(`release/buttons/${name}.svg`, releaseButtonSvg(label));
