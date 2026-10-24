// 提问箱 / Q&A box, drawn as a postcard to write on and letters going back and forth.
// Talks to ask-api (see ask-api/README.md). User-written text is only inserted with textContent.
import { el, createApi, fmtDate } from './askbox-common.js';

const STORE_KEY = 'askbox:mine';
const PAGE_SIZE = 10;
const BADMINTON = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 14.2 5 3.5h14l-3.6 10.7"/><path d="M10 3.5l.9 10.7M14 3.5l-.9 10.7M6.3 7.5h11.4M7.4 10.9h9.2"/><path d="M8.6 14.2h6.8v1.3a3.4 3.4 0 0 1-6.8 0z" fill="currentColor"/></svg>';
const ARROW = '<svg width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M0 5h15M11 1l4 4-4 4"/></svg>';

const root = document.querySelector('[data-askbox]');
if (root) init(root);

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
}

function postmark(top, date) {
  return svg(`<svg class="pmark" viewBox="0 0 120 72" aria-hidden="true"><defs><path id="pm-ask" d="M18 36a24 24 0 1 1 48 0a24 24 0 1 1 -48 0"/></defs><g fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="42" cy="36" r="30"/><circle cx="42" cy="36" r="20"/><path d="M76 22c8-4 14 4 22 0s14 4 22 0M76 36c8-4 14 4 22 0s14 4 22 0M76 50c8-4 14 4 22 0s14 4 22 0"/></g><text fill="currentColor" font-family="Jost,sans-serif" font-size="7" letter-spacing="1.6"><textPath href="#pm-ask">${top}</textPath></text><text x="42" y="39" fill="currentColor" font-family="Jost,sans-serif" font-size="7.5" text-anchor="middle" letter-spacing=".5">${date}</text></svg>`);
}

function init(root) {
  const cfg = JSON.parse(root.dataset.config);
  const t = (key, n) => (cfg.strings[key] ?? key).replace('{n}', n ?? '');

  if (!cfg.api) {
    root.replaceChildren(el('p', { class: 'askbox-status' }, t('not_open')));
    return;
  }

  const api = createApi(cfg.api);
  importFromHash();

  // ---------- the postcard ----------
  const textarea = el('textarea', { placeholder: t('placeholder'), 'aria-label': t('placeholder') });
  const count = el('div', { class: 'cnt' });
  const honeypot = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'askbox-hp', 'aria-hidden': 'true' });
  const slot = cfg.turnstileSiteKey ? el('div', { class: 'askbox-captcha' }) : null;
  const widget = slot ? turnstile(cfg.turnstileSiteKey, slot) : null;
  const send = el('button', { type: 'submit', class: 'btn' }, t('send'), ' ', svg(ARROW));
  const status = el('p', { class: 'askbox-status', role: 'status', 'aria-live': 'polite' });
  const notice = el('div', { class: 'askbox-notice', hidden: true });
  const stamp = el('div', { class: 'pstamp' }, el('div', { class: 'ill', style: 'color:var(--card-red)' }, svg(BADMINTON)));
  const pc = el('div', { class: 'pc' },
    el('div', { class: 'l' }, textarea, count),
    el('div', { class: 'r' }, stamp,
      el('div', { class: 'addr' },
        el('span', {}, t('to')), el('b', {}, t('to_name')), el('b', { style: 'font-size:19px' }, t('to_addr')),
        el('span', { style: 'margin-top:10px' }, t('from')), el('b', {}, t('from_name')))),
    postmark('MONTRÉAL · QC · CANADA · ', String(new Date().getFullYear())));
  const form = el('form', { class: 'compose', novalidate: true },
    pc, honeypot, slot,
    el('div', { class: 'send-row' }, el('p', {}, t('note')), send),
    status, notice);

  const updateCount = () => {
    const left = cfg.maxChars - [...textarea.value].length;
    count.textContent = t('char_count', left);
    count.style.color = left < 0 ? 'var(--card-red)' : '';
    send.disabled = left < 0;
  };
  textarea.addEventListener('input', updateCount);
  updateCount();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    status.classList.remove('is-error');
    if (!text) { status.textContent = t('error_empty'); status.classList.add('is-error'); textarea.focus(); return; }
    send.disabled = true;
    status.textContent = t('sending');
    try {
      const data = await api('POST', '/api/threads', {
        body: { body: text, lang: cfg.lang, website: honeypot.value, turnstileToken: widget?.token() },
      });
      remember(data.thread.id, data.askerToken);
      textarea.value = '';
      status.textContent = '';
      showSent(data.thread.id, data.askerToken);
      await refreshMine();
    } catch (err) {
      status.textContent = errorText(err);
      status.classList.add('is-error');
    } finally {
      widget?.reset();
      updateCount();
    }
  });

  // ---------- letters you sent ----------
  const mineList = el('div', { class: 'mine' });
  const mineAside = el('aside', { hidden: true },
    el('h2', { class: 'sec-h' }, t('mine_title')),
    mineList,
    el('p', { class: 'muted', style: 'margin:14px 0 0;font-size:13.5px' }, t('mine_hint')));

  // ---------- answered letters ----------
  const total = el('span', { class: 'count' });
  const list = el('div', { class: 'thread-list', style: 'display:grid;gap:44px' });
  const more = el('button', { type: 'button', class: 'btn ghost', hidden: true }, t('load_more'));
  more.addEventListener('click', () => loadPublic(false));
  const threads = el('section', { class: 'threads' },
    el('h2', { class: 'sec-h' }, t('answered_title'), ' ', total),
    list,
    el('div', { class: 'more-row' }, more));

  root.replaceChildren(el('div', { class: 'ask-grid' }, form, mineAside), threads);

  let cursor = null;
  refreshMine();
  loadPublic(true);

  async function loadPublic(reset) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor && !reset) qs.set('cursor', cursor);
    more.disabled = true;
    try {
      const data = await api('GET', `/api/threads?${qs}`);
      if (reset) list.replaceChildren();
      for (const thread of data.threads) list.append(letters(thread, true));
      if (!list.children.length) list.append(el('p', { class: 'muted' }, t('empty')));
      total.textContent = data.total ? t('total', data.total) : '';
      cursor = data.nextCursor;
      more.hidden = !cursor;
      scrollToHash();
    } catch (err) {
      list.append(el('p', { class: 'askbox-status is-error' }, errorText(err)));
    } finally {
      more.disabled = false;
    }
  }

  async function refreshMine() {
    const items = loadMine();
    if (!items.length) { mineAside.hidden = true; return; }
    try {
      const { threads: mine } = await api('POST', '/api/threads/lookup', { body: { items } });
      saveMine(items.filter((i) => mine.some((th) => th.id === i.id)));
      mineList.replaceChildren(...mine.map(mineItem));
      mineAside.hidden = !mine.length;
    } catch (err) {
      mineList.replaceChildren(el('p', { class: 'askbox-status is-error' }, errorText(err)));
      mineAside.hidden = false;
    }
  }

  // One letter per message: questions on plain paper, replies on ruled paper with the seal.
  function letter(m) {
    const owner = m.author === 'owner';
    return el('div', { class: `lt ${owner ? 'a' : 'q'}` },
      el('div', { class: 'who' },
        el('span', {}, owner ? t('role_owner') : t('role_asker')),
        el('span', {}, fmtDate(m.createdAt, cfg.locale) + (m.edited ? ` · ${t('edited')}` : ''))),
      el('div', { class: 'txt' }, m.body),
      owner ? el('div', { class: 'sig' }, el('span', { class: 'seal' }, '语辰')) : null);
  }

  // A public thread: the question and the first reply, the rest folded away.
  function letters(thread, foldable) {
    const msgs = thread.messages;
    const firstReply = msgs.findIndex((m) => m.author === 'owner');
    const foldAt = firstReply === -1 ? msgs.length : firstReply + 1;
    const box = el('div', { class: 'thread', id: `q-${thread.id}` });
    msgs.forEach((m, i) => {
      const node = letter(m);
      if (foldable && i >= foldAt) node.classList.add('f');
      box.append(node);
    });
    if (foldable && msgs.length > foldAt) {
      const btn = el('button', { type: 'button', class: 'unfold', 'aria-expanded': 'false' }, t('unfold_letters', msgs.length));
      btn.addEventListener('click', () => {
        const open = box.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? t('fold') : t('unfold_letters', msgs.length);
      });
      box.append(btn);
    }
    return box;
  }

  // Your own question: its status, the conversation so far, and a way to write back.
  function mineItem(thread) {
    const [first, ...rest] = thread.messages;
    const st = el('div', { class: `st${thread.awaitingReply ? '' : ' done'}` }, el('i'), thread.awaitingReply ? t('awaiting') : t('answered_mark'));
    const it = el('div', { class: 'it' }, st, el('p', { class: 'q txt' }, first.body));
    if (rest.length) it.append(el('div', { class: 'conv' }, rest.map(letter)));
    if (thread.closed || thread.hidden) {
      it.append(el('p', { class: 'muted', style: 'margin:8px 0 0;font-size:13.5px' }, t('closed')));
    } else if (!thread.awaitingReply) {
      it.append(followUp(thread));
    }
    const copy = el('button', { type: 'button', class: 'copy' }, t('copy_link'));
    copy.addEventListener('click', () => copyText(privateLink(thread.id, tokenFor(thread.id)), copy));
    it.append(el('div', { style: 'margin-top:8px' }, copy));
    return it;
  }

  function followUp(thread) {
    const box = el('textarea', { placeholder: t('followup_placeholder'), 'aria-label': t('followup_placeholder') });
    const go = el('button', { type: 'submit', class: 'btn', style: 'height:34px;padding:0 16px' }, t('submit'));
    const note = el('span', { role: 'status' });
    const f = el('form', { class: 'followup', novalidate: true }, box, el('div', { class: 'row' }, note, go));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) { note.textContent = t('error_empty'); return; }
      go.disabled = true;
      note.textContent = t('sending');
      try {
        await api('POST', `/api/threads/${thread.id}/messages`, { body: { body: text }, token: tokenFor(thread.id) });
        await refreshMine();
      } catch (err) {
        note.textContent = errorText(err);
        go.disabled = false;
      }
    });
    return f;
  }

  function showSent(id, token) {
    const link = privateLink(id, token);
    const input = el('input', { class: 'askbox-link', readonly: true, value: link, 'aria-label': t('copy_link') });
    input.addEventListener('focus', () => input.select());
    const copy = el('button', { type: 'button', class: 'btn ghost' }, t('copy'));
    copy.addEventListener('click', () => copyText(link, copy, input));
    notice.replaceChildren(
      el('p', {}, el('b', {}, t('sent'))),
      el('p', { class: 'muted' }, t('private_link')),
      el('div', { class: 'askbox-link-row' }, input, copy));
    notice.hidden = false;
  }

  function errorText(err) {
    switch (err.code) {
      case 'network': return t('error_network');
      case 'rate_limited': return t('error_rate_limited');
      case 'too_many_pending': return t('error_too_many_pending');
      case 'too_long': return t('error_too_long', cfg.maxChars);
      case 'empty': return t('error_empty');
      case 'captcha_required':
      case 'captcha_failed': return t('error_captcha');
      case 'closed': return t('error_closed');
      default: return t('error_generic');
    }
  }

  async function copyText(text, button, input) {
    try {
      await navigator.clipboard.writeText(text);
      const label = button.textContent;
      button.textContent = t('copied');
      setTimeout(() => (button.textContent = label), 1500);
    } catch {
      input?.select();
    }
  }
}

// ---------- asker tokens (kept only in this browser) ----------
function loadMine() {
  try {
    const items = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(items) ? items.filter((x) => x && typeof x.id === 'string' && typeof x.token === 'string') : [];
  } catch {
    return [];
  }
}

function saveMine(items) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {}
}

function remember(id, token) {
  saveMine([{ id, token }, ...loadMine().filter((x) => x.id !== id)]);
}

function tokenFor(id) {
  return loadMine().find((x) => x.id === id)?.token;
}

// `#mine=<id>.<token>` lets the asker pick the conversation up on another device.
function privateLink(id, token) {
  return `${location.origin}${location.pathname}#mine=${id}.${token}`;
}

function importFromHash() {
  const m = location.hash.match(/^#mine=([A-Za-z0-9]{6,32})\.([A-Za-z0-9_-]{20,200})$/);
  if (!m) return;
  remember(m[1], m[2]);
  history.replaceState(null, '', location.pathname + location.search);
}

function scrollToHash() {
  const m = location.hash.match(/^#(q-[A-Za-z0-9]{6,32})$/);
  const target = m ? document.getElementById(m[1]) : null;
  if (target) {
    target.classList.add('open');
    target.scrollIntoView({ block: 'center' });
  }
}

let turnstileReady;
function turnstile(siteKey, slot) {
  turnstileReady ??= new Promise((resolve) => {
    window.__askboxTurnstileLoaded = resolve;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__askboxTurnstileLoaded';
    s.async = true;
    document.head.append(s);
  });
  let widgetId = null;
  turnstileReady.then(() => {
    widgetId = window.turnstile.render(slot, { sitekey: siteKey });
  });
  return {
    token: () => (widgetId == null ? undefined : window.turnstile.getResponse(widgetId)),
    reset: () => widgetId != null && window.turnstile.reset(widgetId),
  };
}
