// Site behaviour: navigation that folds before it crosses the diagonal, search, day/night,
// essay paper, colourway switch, and the small interactive bits. Pages work without it.

const root = document.documentElement;
const script = document.currentScript || document.querySelector('script[data-search]');
const S = JSON.parse(script?.dataset.strings || '{}');
const store = {
  get(k, d) { try { const v = localStorage.getItem('yh:' + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('yh:' + k, v); } catch {} },
};

/* ---------- Layout: fold the link row and the search field before they cross the diagonal ---------- */
function layout() {
  const card = document.getElementById('card');
  const nav = document.getElementById('nav');
  if (!card || !nav) return;
  nav.classList.remove('is-collapsed', 'is-compact');
  const host = card.classList.contains('home') ? card : card.querySelector('.band');
  if (!host) return;
  const W = host.clientWidth, H = host.clientHeight;
  const home = card.classList.contains('home');
  if (W < 741) {
    nav.classList.add('is-collapsed', 'is-compact');
    if (home) {
      const map = document.getElementById('hero-map');
      if (map) { map.hidden = false; map.style.width = ''; }
      // The diagonal runs behind the drawings, or just under the map when there are none.
      const figs = document.getElementById('figs');
      const name = card.querySelector('.hero-name');
      const top = figs ? figs.offsetTop + 40 : name.offsetTop + name.offsetHeight - 10;
      const bottom = figs ? figs.offsetTop + figs.offsetHeight + 30 : top + 110;
      card.style.setProperty('--p1', top + 'px');
      card.style.setProperty('--p2', bottom + 'px');
    }
    return;
  }
  const cs = getComputedStyle(host);
  const tx = parseFloat(cs.getPropertyValue('--tx')) / 100;
  const bx = parseFloat(cs.getPropertyValue('--bx')) / 100;
  const hb = host.getBoundingClientRect();
  const lineAt = (y) => hb.left + W * tx - W * (tx - bx) * ((y - hb.top) / H);
  const links = nav.querySelector('.links').getBoundingClientRect();
  if (links.right > lineAt(links.top + links.height / 2) - 18) nav.classList.add('is-collapsed');
  const tools = nav.querySelector('.tools').getBoundingClientRect();
  if (tools.left < lineAt(tools.top + tools.height / 2) + 14) nav.classList.add('is-compact');
  if (home) {
    // The hand-drawn map takes whatever room is left between the buttons and the social icons.
    const map = document.getElementById('hero-map');
    if (map) {
      map.hidden = false; map.style.width = '';
      const room = card.querySelector('.hero-foot').getBoundingClientRect().top - map.getBoundingClientRect().top - 22;
      const w = Math.min(map.parentElement.clientWidth, room * 874 / 474);
      if (w < 170) map.hidden = true; else map.style.width = w + 'px';
    }
    card.classList.remove('tight');
    const top = card.querySelector('.fig-set[data-for="' + root.dataset.palette + '"] .fig');
    if (top && card.querySelector('.hero-note').getBoundingClientRect().top < top.getBoundingClientRect().bottom + 8) card.classList.add('tight');
  }
}
const frame = document.getElementById('frame');
if (frame && 'ResizeObserver' in window) new ResizeObserver(() => layout()).observe(frame);
window.addEventListener('load', layout);

/* ---------- Menu drawer ---------- */
function openDrawer() {
  const tpl = document.getElementById('drawer-tpl');
  if (!tpl) return;
  const d = tpl.content.firstElementChild.cloneNode(true);
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]') || e.target.closest('a')) d.remove(); });
  document.body.append(d);
  d.querySelector('[data-close]').focus();
}

/* ---------- Search ---------- */
let index = null;
async function loadIndex() {
  if (index) return index;
  try {
    const res = await fetch(script.dataset.search);
    index = await res.json();
  } catch { index = []; }
  return index;
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function runSearch(q) {
  const box = document.getElementById('results');
  if (!box) return;
  q = q.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }
  const items = await loadIndex();
  const scored = [];
  for (const it of items) {
    const t = (it.t || '').toLowerCase(), d = (it.d || '').toLowerCase(), x = (it.x || '').toLowerCase();
    let score = 0;
    if (t.includes(q)) score += 10;
    if (d.includes(q)) score += 4;
    const at = x.indexOf(q);
    if (at >= 0) score += 1;
    if (!score) continue;
    let snippet = it.d || '';
    if (at >= 0 && !t.includes(q) && !d.includes(q)) {
      const s = Math.max(0, at - 30);
      snippet = (s ? '…' : '') + it.x.slice(s, at + q.length + 50) + '…';
    }
    scored.push({ ...it, score, snippet });
  }
  scored.sort((a, b) => b.score - a.score);
  box.innerHTML = scored.length
    ? scored.slice(0, 8).map((h, i) => `<a href="${esc(h.u)}" class="${i ? '' : 'hl'}"><span class="kind">${esc(h.k)}</span><b>${esc(h.t)}</b><small>${esc(h.snippet)}</small></a>`).join('')
    : `<div class="none">${esc(S.noResult || 'Nothing found')}</div>`;
  box.hidden = false;
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- Essay paper: parchment (default) / plain ---------- */
const article = document.getElementById('article');
function setPaper(mode) {
  if (!article) return;
  const btn = document.querySelector(`[data-paper="${mode}"]`);
  if (!btn) mode = 'parch';
  article.dataset.paper = mode;
  document.querySelectorAll('[data-paper]').forEach((b) => b !== article && b.setAttribute('aria-pressed', String(b.dataset.paper === mode)));
}
if (article) setPaper(store.get('paper', 'parch'));

/* ---------- Album: category tabs and the large photo ---------- */
function filterAlbum(cat) {
  document.querySelectorAll('.tabs [data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === cat)));
  document.querySelectorAll('#album .mount').forEach((m) => { m.hidden = cat !== 'all' && m.dataset.cat !== cat; });
}
function lightbox(btn) {
  const d = document.createElement('div');
  d.className = 'lightbox';
  const box = document.createElement('div');
  box.className = 'mount';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const img = new Image(+btn.dataset.w, +btn.dataset.h);
  img.src = btn.dataset.big;
  img.alt = btn.querySelector('img').alt;
  const win = document.createElement('span');
  win.className = 'win';
  win.append(img);
  const cap = btn.querySelector('.cap').cloneNode(true);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'chip'; close.dataset.close = ''; close.textContent = S.close || '×';
  cap.append(close);
  box.append(win, cap);
  d.append(box);
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) { d.remove(); btn.focus(); } });
  document.body.append(d);
  close.focus();
}

/* ---------- Clicks ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act],[data-paper],[data-cat]');
  if (!el || el === article) return;
  if (el.dataset.paper) { setPaper(el.dataset.paper); store.set('paper', el.dataset.paper); return; }
  if (!el.dataset.act) { filterAlbum(el.dataset.cat); return; }
  switch (el.dataset.act) {
    case 'palette': {
      // Step to the next colourway; the page script restores it on the next visit.
      const P = JSON.parse(script?.dataset.palettes || '[]');
      const next = P[(P.indexOf(root.dataset.palette) + 1) % P.length];
      if (!next) break;
      root.dataset.palette = next;
      store.set('palette', next);
      layout();
      break;
    }
    case 'lightbox': lightbox(el); break;
    case 'night': {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      store.set('theme', root.dataset.theme);
      break;
    }
    case 'menu': openDrawer(); break;
    case 'search-open': {
      document.getElementById('nav').classList.toggle('search-open');
      document.getElementById('q').focus();
      break;
    }
    case 'copy-mail': {
      e.preventDefault();
      const addr = `${el.dataset.user}@${el.dataset.domain}`;
      try { await navigator.clipboard.writeText(addr); toast(S.copied || addr); } catch { toast(addr); }
      break;
    }
    case 'scroll': {
      const open = document.getElementById('hscroll').classList.toggle('open');
      el.setAttribute('aria-expanded', String(open));
      el.textContent = open ? S.scrollClose : S.scrollOpen;
      break;
    }
  }
});

/* ---------- Keyboard and search box ---------- */
document.addEventListener('input', (e) => { if (e.target.id === 'q') runSearch(e.target.value); });
document.addEventListener('focusin', (e) => { if (e.target.id === 'q') loadIndex(); });
document.addEventListener('focusout', (e) => {
  if (e.target.id !== 'q') return;
  setTimeout(() => { const r = document.getElementById('results'); if (r && !r.contains(document.activeElement)) r.hidden = true; }, 160);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    const q = document.getElementById('q');
    if (q) { e.preventDefault(); document.getElementById('nav').classList.add('search-open'); q.focus(); }
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('.drawer,.lightbox').forEach((d) => d.remove());
    const r = document.getElementById('results'); if (r) r.hidden = true;
  }
  if (e.key === 'Enter' && e.target.id === 'q') {
    const a = document.querySelector('#results a');
    if (a) location.href = a.href;
  }
});

/* ---------- Home: the latest answered question in the Q&A row ---------- */
const latest = document.querySelector('[data-ask-latest]');
if (latest && latest.dataset.askLatest) {
  fetch(latest.dataset.askLatest.replace(/\/+$/, '') + '/api/threads?limit=1')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const t = d?.threads?.[0];
      const q = t?.messages.find((m) => m.author === 'asker');
      if (!q) return;
      const body = q.body.replace(/\s+/g, ' ').trim();
      latest.href += '#q-' + t.id;
      latest.querySelector('.k').textContent = latest.dataset.label;
      const text = latest.querySelector('.t');
      text.textContent = body;
      text.title = body;
      const at = new Date(t.publishedAt);
      latest.querySelector('.d').textContent = `${at.getFullYear()}.${String(at.getMonth() + 1).padStart(2, '0')}`;
    })
    .catch(() => {});
}

/* ---------- Recipe: tick ingredients off while cooking ---------- */
const letter = document.querySelector('.letter[data-recipe]');
if (letter) {
  const key = 'ing:' + letter.dataset.recipe;
  const done = new Set(JSON.parse(store.get(key, '[]')));
  letter.querySelectorAll('input[data-ing]').forEach((box) => {
    box.checked = done.has(box.dataset.ing);
    box.addEventListener('change', () => {
      if (box.checked) done.add(box.dataset.ing); else done.delete(box.dataset.ing);
      store.set(key, JSON.stringify([...done]));
    });
  });
}

/* ---------- Essay: reading progress and the route ---------- */
const progress = document.getElementById('progress');
const read = document.querySelector('.read');
const routeLinks = [...document.querySelectorAll('.route a[href^="#"]')];
if (progress && read) {
  const onScroll = () => {
    const r = read.getBoundingClientRect();
    const total = r.height - innerHeight * 0.6;
    progress.style.setProperty('--p', Math.max(0, Math.min(100, (-r.top + innerHeight * 0.2) / total * 100)) + '%');
    let current = null;
    for (const a of routeLinks) {
      const h = document.getElementById(decodeURIComponent(a.hash.slice(1)));
      if (h && h.getBoundingClientRect().top < innerHeight * 0.35) current = a;
    }
    routeLinks.forEach((a) => a.parentElement.classList.toggle('on', a === (current || routeLinks[0])));
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---------- Dreams: keep the star labels on the chart from overlapping ----------
   Stars a few days apart sit side by side, and their date labels can land on each other
   or on a neighbouring star. First the year on each ring slides sideways along the top
   until no star covers it. Then the date labels are placed newest first; one that hits a
   star, the chart's own text or a label already placed takes the nearest free spot a few
   pixels away, trying its data-push direction first and sideways moves last. The boxes
   follow the digits (about 10px tall), not the font's full line height. Without the
   script the labels only overlap; the list next to the chart has the dates. */
const LABEL_MOVES = [];
for (let dy = -42; dy <= 42; dy += 6) for (let dx = -24; dx <= 24; dx += 6) LABEL_MOVES.push([dx, dy]);
LABEL_MOVES.sort((p, q) => (Math.abs(p[0]) * 1.5 + Math.abs(p[1])) - (Math.abs(q[0]) * 1.5 + Math.abs(q[1])) || q[1] - p[1]);
const YEAR_MOVES = [0];
for (let d = 8; d <= 96; d += 8) YEAR_MOVES.push(-d, d);
function unclutterStars() {
  document.querySelectorAll('svg.chart').forEach((svg) => {
    const inv = svg.getScreenCTM()?.inverse();
    if (!inv) return;
    const boxOf = (t) => {
      const r = t.getBoundingClientRect();
      const p = new DOMPoint(r.left, r.top).matrixTransform(inv), q = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
      return { x: p.x, y: p.y + (q.y - p.y) * 0.2, w: q.x - p.x, h: (q.y - p.y) * 0.6 };
    };
    const hits = (b, o) => b.x < o.x + o.w + 3 && b.x + b.w + 3 > o.x && b.y < o.y + o.h + 1 && b.y + b.h + 1 > o.y;
    const stars = [...svg.querySelectorAll('.dream-star')].map((a) => {
      const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(a.querySelector('g').getAttribute('transform') || '');
      return m && { a, sx: +m[1], sy: +m[2] };
    }).filter(Boolean);
    const boxes = stars.map(({ sx, sy }) => ({ x: sx - 10, y: sy - 10, w: 20, h: 20 }));
    // Each ring's year slides along the top of its ring to a spot no star covers.
    svg.querySelectorAll('text.yr').forEach((t) => {
      if (t.dataset.x0 == null) t.dataset.x0 = t.getAttribute('x');
      t.setAttribute('x', t.dataset.x0);
      const b = boxOf(t);
      const dx = YEAR_MOVES.find((d) => !boxes.some((o) => hits({ ...b, x: b.x + d }, o))) || 0;
      if (dx) t.setAttribute('x', +t.dataset.x0 + dx);
      boxes.push({ ...b, x: b.x + dx });
    });
    // The month names are in the way too.
    svg.querySelectorAll('text').forEach((t) => { if (!t.closest('.dream-star') && !t.classList.contains('yr')) boxes.push(boxOf(t)); });
    const labels = stars.map(({ a, sx, sy }) => {
      const t = a.querySelector('text');
      if (!t) return null;
      if (t.dataset.x0 == null) { t.dataset.x0 = t.getAttribute('x'); t.dataset.y0 = t.getAttribute('y'); }
      t.setAttribute('x', t.dataset.x0);
      t.setAttribute('y', t.dataset.y0);
      const b = t.getBBox();
      return { t, dir: t.dataset.push === 'up' ? -1 : 1, x0: b.x + sx, y0: +t.dataset.y0 + sy - 10, w: b.width, h: 11 };
    }).filter(Boolean);
    const free = (x, y, l) => !boxes.some((o) => hits({ x, y, w: l.w, h: l.h }, o));
    for (const l of labels) {
      const [dx, dy] = LABEL_MOVES.find(([dx, dy]) => free(l.x0 + dx, l.y0 + dy * l.dir, l)) || [0, 0];
      l.x = l.x0 + dx; l.y = l.y0 + dy * l.dir;
      if (dx) l.t.setAttribute('x', +l.t.dataset.x0 + dx);
      if (dy) l.t.setAttribute('y', +l.t.dataset.y0 + dy * l.dir);
      boxes.push(l);
    }
  });
}
if (document.querySelector('.dream-star')) {
  unclutterStars();
  document.fonts?.ready.then(unclutterStars);
  addEventListener('load', unclutterStars);
}
