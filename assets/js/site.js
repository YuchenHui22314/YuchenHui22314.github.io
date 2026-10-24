// Site behaviour: navigation that folds before it crosses the diagonal, search, day/night,
// essay paper modes, and the small interactive bits. Pages work without it.

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
      const figs = document.getElementById('figs');
      card.style.setProperty('--p1', (figs.offsetTop + 40) + 'px');
      card.style.setProperty('--p2', (figs.offsetTop + figs.offsetHeight + 30) + 'px');
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

/* ---------- Essay paper: plain / parchment / vertical ---------- */
const article = document.getElementById('article');
function setPaper(mode) {
  if (!article) return;
  const btn = document.querySelector(`[data-paper="${mode}"]`);
  if (!btn) mode = 'plain';
  article.dataset.paper = mode;
  document.querySelectorAll('[data-paper]').forEach((b) => b !== article && b.setAttribute('aria-pressed', String(b.dataset.paper === mode)));
  const note = document.querySelector('.vnote');
  if (note) note.hidden = mode !== 'vert';
}
if (article) setPaper(store.get('paper', 'plain'));

/* ---------- Clicks ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act],[data-paper]');
  if (!el || el === article) return;
  if (el.dataset.paper) { setPaper(el.dataset.paper); store.set('paper', el.dataset.paper); return; }
  switch (el.dataset.act) {
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
    case 'bib': {
      const pre = el.closest('.icard').querySelector('.bib');
      pre.hidden = !pre.hidden;
      el.setAttribute('aria-expanded', String(!pre.hidden));
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
    document.querySelectorAll('.drawer').forEach((d) => d.remove());
    const r = document.getElementById('results'); if (r) r.hidden = true;
  }
  if (e.key === 'Enter' && e.target.id === 'q') {
    const a = document.querySelector('#results a');
    if (a) location.href = a.href;
  }
});

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
