// Generates the decorative SVGs (contour lines, stars, compass, mountain ridges, pine scape)
// as Hugo partials, using the same seeded algorithms as the design mock-up.
// Run: node tools/gen-deco.mjs   (writes layouts/_partials/deco/*.html)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'layouts', '_partials', 'deco');
mkdirSync(OUT, { recursive: true });

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function compass() {
  let ticks = '';
  for (let i = 0; i < 64; i++) {
    const a = i / 64 * Math.PI * 2, l = i % 8 === 0 ? 9 : i % 4 === 0 ? 6 : 3.5;
    ticks += `<line x1="${(Math.sin(a) * 92).toFixed(2)}" y1="${(-Math.cos(a) * 92).toFixed(2)}" x2="${(Math.sin(a) * (92 - l)).toFixed(2)}" y2="${(-Math.cos(a) * (92 - l)).toFixed(2)}"/>`;
  }
  const pt = (r1, r2, n, rot) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const a = rot + i / n * Math.PI * 2, b = a + Math.PI / n, c = a - Math.PI / n;
      d += `M0 0L${(Math.sin(c) * r2).toFixed(2)} ${(-Math.cos(c) * r2).toFixed(2)}L${(Math.sin(a) * r1).toFixed(2)} ${(-Math.cos(a) * r1).toFixed(2)}L${(Math.sin(b) * r2).toFixed(2)} ${(-Math.cos(b) * r2).toFixed(2)}Z`;
    }
    return d;
  };
  return `<svg class="{{ .class }}"{{ with .style }} style="{{ . | safeCSS }}"{{ end }} viewBox="-100 -100 200 200" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width=".8"><circle r="96"/><circle r="92"/><circle r="70"/><circle r="22"/>${ticks}</g><path d="${pt(64, 9, 8, Math.PI / 8)}" fill="none" stroke="currentColor" stroke-width=".8"/><path d="${pt(84, 12, 4, 0)}" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width=".9"/><g fill="currentColor" font-family="IM Fell English,serif" font-size="15" text-anchor="middle"><text y="-74">N</text><text x="78" y="5">E</text><text y="85">S</text><text x="-78" y="5">W</text></g></svg>`;
}

function contours(seed) {
  const r = rng(seed); let out = '';
  [[880, 560, 15, 34], [640, 170, 7, 26]].forEach(([cx, cy, n, gap]) => {
    const ph = [r() * 6, r() * 6, r() * 6];
    for (let k = 1; k <= n; k++) {
      let d = '';
      for (let i = 0; i <= 120; i++) {
        const t = i / 120 * Math.PI * 2;
        const rad = k * gap * (1 + .16 * Math.sin(2 * t + ph[0]) + .09 * Math.sin(3 * t + ph[1]) + .05 * Math.sin(5 * t + ph[2] + k * .3));
        d += `${i ? 'L' : 'M'}${(cx + Math.cos(t) * rad * 1.25).toFixed(1)} ${(cy + Math.sin(t) * rad * .8).toFixed(1)}`;
      }
      out += `<path d="${d}Z" stroke-width="${k % 5 === 0 ? 1.6 : .8}"/>`;
    }
  });
  return `<svg class="contours" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" aria-hidden="true">${out}</svg>`;
}

function stars(seed, n) {
  const r = rng(seed); let s = '';
  for (let i = 0; i < n; i++) {
    const x = (r() * 1000).toFixed(1), y = (r() * 640).toFixed(1), rad = (.4 + r() * r() * 1.4).toFixed(2), o = (.35 + r() * .6).toFixed(2);
    s += `<circle${i % 7 === 0 ? ' class="tw"' : ''} cx="${x}" cy="${y}" r="${rad}" fill="currentColor" opacity="${o}"/>`;
  }
  return `<svg class="stars" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${s}</svg>`;
}

function ridge(r, base, amp, rough) {
  let pts = [base + (r() - .5) * amp, base + (r() - .5) * amp]; let step = amp;
  for (let it = 0; it < 6; it++) {
    const nx = [];
    for (let i = 0; i < pts.length - 1; i++) nx.push(pts[i], (pts[i] + pts[i + 1]) / 2 + (r() - .5) * step);
    nx.push(pts[pts.length - 1]); pts = nx; step *= rough;
  }
  return 'M0 120' + pts.map((y, i) => `L${(i / (pts.length - 1) * 1000).toFixed(1)} ${y.toFixed(1)}`).join('') + 'L1000 120Z';
}

function ridges(seed) {
  const r = rng(seed);
  return `<svg class="ridges" viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden="true"><path d="${ridge(r, 50, 90, .62)}" fill="var(--ridge-2)" opacity=".55"/><path d="${ridge(r, 66, 70, .58)}" fill="var(--ridge-1)" opacity=".85"/><path d="${ridge(r, 96, 34, .5)}" fill="var(--paper)"/></svg>`;
}

function scape(seed) {
  const r = rng(seed); let trees = '';
  for (let i = 0; i < 46; i++) {
    const x = r() * 1000, h = 16 + r() * 34, y = 92 + r() * 22, w = h * .34;
    trees += `<path d="M${x.toFixed(1)} ${(y - h).toFixed(1)}L${(x + w).toFixed(1)} ${y.toFixed(1)}L${(x - w).toFixed(1)} ${y.toFixed(1)}Z"/>`;
  }
  return `<svg class="scape" viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden="true"><path d="${ridge(r, 50, 60, .55)}" fill="var(--ridge-2)" opacity=".6"/><path d="${ridge(r, 76, 40, .5)}" fill="var(--ridge-1)"/><g fill="var(--tree)" opacity=".85">${trees}</g><path d="M0 104C200 98 380 112 560 106S860 98 1000 104V120H0Z" fill="var(--R-bg)"/></svg>`;
}

// The dream star chart: faint background stars, the outer rings and twelve month ticks.
// Month names come from the caller: {{ partial "deco/chart-frame.html" (split (T "months") " ") }}
function chartFrame() {
  const r = rng(5); let bg = '';
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * 196;
    bg += `<circle cx="${(Math.cos(a) * rad).toFixed(1)}" cy="${(Math.sin(a) * rad).toFixed(1)}" r="${(.3 + r() * .9).toFixed(2)}" opacity="${(.2 + r() * .5).toFixed(2)}"/>`;
  }
  let ticks = '';
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2 - Math.PI / 2, a2 = (i + .5) / 12 * Math.PI * 2 - Math.PI / 2;
    ticks += `<line x1="${(Math.cos(a) * 192).toFixed(1)}" y1="${(Math.sin(a) * 192).toFixed(1)}" x2="${(Math.cos(a) * 200).toFixed(1)}" y2="${(Math.sin(a) * 200).toFixed(1)}" stroke="currentColor" stroke-opacity=".4"/>`
      + `<text x="${(Math.cos(a2) * 180).toFixed(1)}" y="${(Math.sin(a2) * 180 + 3).toFixed(1)}" text-anchor="middle">{{ index . ${i} }}</text>`;
  }
  return `<g class="bg">${bg}</g><circle class="ring" r="200"/><circle class="ring" r="160"/>${ticks}`;
}

// Page keys and seeds follow the mock-up so the pictures match what was approved.
const PAGES = ['home', 'research', 'publications', 'essays', 'essay', 'dreams', 'dream', 'recipes', 'recipe', 'album', 'ask', 'notes', 'about'];
const write = (name, svg) => writeFileSync(join(OUT, `${name}.html`), svg + '\n');

write('compass', compass());
write('chart-frame', chartFrame());
write('scape', scape(77));
write('contours-home', contours(11));
write('stars-home', stars(12, 150));
for (const key of ['about', 'research', 'essays', 'dreams', 'recipes', 'album', 'ask']) {
  const i = PAGES.indexOf(key);
  write(`contours-${key}`, contours(i * 7 + 3));
  write(`stars-${key}`, stars(i * 7 + 4, 150));
  write(`ridges-${key}`, ridges(i * 13 + 5));
}
console.log('wrote', OUT);
