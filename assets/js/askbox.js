// 提问箱 / Q&A box widget. Talks to ask-api (see ask-api/README.md).
// User-written text is only ever inserted with textContent.
import { el, createApi, fmtDate } from './askbox-common.js';

const STORE_KEY = 'askbox:mine';
const PAGE_SIZE = 10;

const root = document.querySelector('[data-askbox]');
if (root) init(root);

function init(root) {
  const cfg = JSON.parse(root.dataset.config);
  const t = (key, n) => (cfg.strings[key] ?? key).replace('{n}', n ?? '');

  if (!cfg.api) {
    root.replaceChildren(el('p', { class: 'askbox-notice' }, t('not_open')));
    return;
  }

  const api = createApi(cfg.api);
  importFromHash();

  // ---------- layout ----------
  const notice = el('div', { class: 'askbox-notice', hidden: true });
  const mineList = el('div', { class: 'askbox-list' });
  const mineSection = el('section', { class: 'askbox-section askbox-mine', hidden: true },
    el('h2', { class: 'askbox-heading' }, t('mine_title')),
    el('p', { class: 'askbox-muted' }, t('mine_hint')),
    mineList);
  const publicList = el('div', { class: 'askbox-list' });
  const count = el('span', { class: 'askbox-count' });
  const loadMore = el('button', { type: 'button', class: 'askbox-button askbox-button--ghost', hidden: true, onclick: () => loadPublic(false) }, t('load_more'));
  const publicSection = el('section', { class: 'askbox-section' },
    el('h2', { class: 'askbox-heading' }, t('answered_title'), ' ', count),
    publicList,
    el('div', { class: 'askbox-more' }, loadMore));

  const ask = composer({
    placeholder: t('placeholder'),
    rows: 4,
    captcha: true,
    onSubmit: async ({ text, website, captchaToken }) => {
      const data = await api('POST', '/api/threads', {
        body: { body: text, lang: cfg.lang, website, turnstileToken: captchaToken },
      });
      remember(data.thread.id, data.askerToken);
      showSent(data.thread.id, data.askerToken);
      await refreshMine();
    },
  });

  root.replaceChildren(
    el('section', { class: 'askbox-section askbox-ask' }, ask.form, el('p', { class: 'askbox-muted' }, t('note'))),
    notice,
    mineSection,
    publicSection,
  );

  let cursor = null;
  refreshMine();
  loadPublic(true);

  // ---------- data ----------
  async function loadPublic(reset) {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor && !reset) qs.set('cursor', cursor);
    loadMore.disabled = true;
    try {
      const data = await api('GET', `/api/threads?${qs}`);
      if (reset) publicList.replaceChildren();
      for (const thread of data.threads) publicList.append(renderThread(thread, false));
      if (!publicList.children.length) publicList.append(el('p', { class: 'askbox-muted' }, t('empty')));
      count.textContent = data.total ? t('total', data.total) : '';
      cursor = data.nextCursor;
      loadMore.hidden = !cursor;
      scrollToHash();
    } catch (err) {
      publicList.append(el('p', { class: 'askbox-status is-error' }, errorText(err)));
    } finally {
      loadMore.disabled = false;
    }
  }

  async function refreshMine() {
    const items = loadMine();
    if (!items.length) {
      mineSection.hidden = true;
      return;
    }
    try {
      const { threads } = await api('POST', '/api/threads/lookup', { body: { items } });
      // Forget threads the owner deleted.
      saveMine(items.filter((i) => threads.some((th) => th.id === i.id)));
      mineList.replaceChildren(...threads.map((th) => renderThread(th, true)));
      mineSection.hidden = !threads.length;
    } catch (err) {
      mineList.replaceChildren(el('p', { class: 'askbox-status is-error' }, errorText(err)));
      mineSection.hidden = false;
    }
  }

  // ---------- rendering ----------
  function renderThread(thread, mine) {
    const messages = thread.messages;
    const firstReply = messages.findIndex((m) => m.author === 'owner');
    const foldAt = firstReply === -1 ? messages.length : firstReply + 1;
    const foldable = messages.length > foldAt;
    let expanded = mine || !foldable;

    const list = el('div', { class: 'askbox-messages' });
    const toggle = el('button', {
      type: 'button',
      class: 'askbox-toggle',
      onclick: () => {
        expanded = !expanded;
        draw();
      },
    });
    function draw() {
      list.replaceChildren(...(expanded ? messages : messages.slice(0, foldAt)).map(renderMessage));
      toggle.hidden = !foldable;
      toggle.textContent = expanded ? t('fold') : t('unfold', messages.length);
      toggle.setAttribute('aria-expanded', String(expanded));
    }
    draw();

    const meta = el('div', { class: 'askbox-thread-meta' },
      el('time', { datetime: new Date(thread.createdAt).toISOString() }, fmtDate(thread.createdAt, cfg.locale)));
    if (mine && thread.awaitingReply) meta.append(el('span', { class: 'askbox-badge' }, t('awaiting')));
    if (mine) {
      const token = tokenFor(thread.id);
      const copyLink = el('button', { type: 'button', class: 'askbox-linkbtn' }, t('copy_link'));
      copyLink.addEventListener('click', () => copyText(privateLink(thread.id, token), copyLink));
      meta.append(copyLink);
    }

    const article = el('article', { class: 'askbox-thread', id: mine ? null : `q-${thread.id}` }, meta, list, toggle);
    if (mine) {
      if (thread.closed || thread.hidden) article.append(el('p', { class: 'askbox-muted' }, t('closed')));
      else article.append(followUp(thread).form);
    }
    return article;
  }

  function renderMessage(m) {
    const who = m.author === 'owner' ? cfg.ownerName : t('role_asker');
    return el('div', { class: `askbox-msg askbox-msg--${m.author}` },
      el('div', { class: 'askbox-msg-head' },
        el('span', { class: 'askbox-msg-who' }, who),
        el('time', { datetime: new Date(m.createdAt).toISOString() }, fmtDate(m.createdAt, cfg.locale)),
        m.edited ? el('span', { class: 'askbox-muted' }, t('edited')) : null),
      el('div', { class: 'askbox-msg-body' }, m.body));
  }

  function followUp(thread) {
    return composer({
      placeholder: t('followup_placeholder'),
      rows: 2,
      onSubmit: async ({ text, website }) => {
        await api('POST', `/api/threads/${thread.id}/messages`, {
          body: { body: text, website },
          token: tokenFor(thread.id),
        });
        await refreshMine();
      },
    });
  }

  function showSent(id, token) {
    const link = privateLink(id, token);
    const input = el('input', { class: 'askbox-link', readonly: true, value: link });
    input.addEventListener('focus', () => input.select());
    const copy = el('button', { type: 'button', class: 'askbox-button askbox-button--ghost' }, t('copy'));
    copy.addEventListener('click', () => copyText(link, copy, input));
    notice.replaceChildren(
      el('p', { class: 'askbox-notice-title' }, t('sent')),
      el('p', { class: 'askbox-muted' }, t('private_link')),
      el('div', { class: 'askbox-link-row' }, input, copy));
    notice.hidden = false;
  }

  // A textarea + send button with a live character counter, honeypot and optional captcha.
  function composer({ placeholder, rows, captcha, onSubmit }) {
    const textarea = el('textarea', { class: 'askbox-input', rows, placeholder, 'aria-label': placeholder });
    const honeypot = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'askbox-hp', 'aria-hidden': 'true' });
    const counter = el('span', { class: 'askbox-counter' });
    const button = el('button', { type: 'submit', class: 'askbox-button' }, t('submit'));
    const status = el('p', { class: 'askbox-status', role: 'status', 'aria-live': 'polite' });
    const slot = captcha && cfg.turnstileSiteKey ? el('div', { class: 'askbox-captcha' }) : null;
    const widget = slot ? turnstile(cfg.turnstileSiteKey, slot) : null;

    const update = () => {
      const left = cfg.maxChars - [...textarea.value].length;
      counter.textContent = t('char_count', left);
      counter.classList.toggle('is-error', left < 0);
      button.disabled = left < 0;
    };
    textarea.addEventListener('input', update);
    update();

    const form = el('form', { class: 'askbox-form', novalidate: true },
      textarea, honeypot, slot,
      el('div', { class: 'askbox-form-row' }, counter, button),
      status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textarea.value.trim();
      status.classList.remove('is-error');
      if (!text) {
        status.textContent = t('error_empty');
        status.classList.add('is-error');
        return;
      }
      button.disabled = true;
      status.textContent = t('sending');
      try {
        await onSubmit({ text, website: honeypot.value, captchaToken: widget?.token() });
        textarea.value = '';
        status.textContent = '';
      } catch (err) {
        status.textContent = errorText(err);
        status.classList.add('is-error');
      } finally {
        widget?.reset();
        update();
      }
    });
    return { form };
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
  const target = m && document.getElementById(m[1]);
  if (target) {
    target.classList.add('is-highlighted');
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
