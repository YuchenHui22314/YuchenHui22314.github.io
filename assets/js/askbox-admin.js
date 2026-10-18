// 提问箱管理页: reply to, hide, close and delete questions. Only usable with the ADMIN_TOKEN secret.
import { el, createApi, fmtDate } from './askbox-common.js';

const TOKEN_KEY = 'askbox:admin-token';
const FILTERS = [
  ['pending', '待回复'],
  ['answered', '已公开'],
  ['hidden', '已隐藏'],
  ['all', '全部'],
];

const root = document.querySelector('[data-askbox-admin]');
if (root) init(root);

function init(root) {
  const cfg = JSON.parse(root.dataset.config);
  if (!cfg.api) {
    root.replaceChildren(el('p', { class: 'askbox-notice' }, '还没有配置提问箱 API（params.askbox.api）。'));
    return;
  }

  let token = readToken();
  let filter = 'pending';
  let offset = 0;
  const api = createApi(cfg.api, () => (token ? { Authorization: `Bearer ${token}` } : {}));

  const tabs = el('div', { class: 'askbox-tabs', role: 'tablist' });
  const list = el('div', { class: 'askbox-list' });
  const more = el('button', { type: 'button', class: 'askbox-button askbox-button--ghost', hidden: true, onclick: () => load(false) }, '加载更多');
  const status = el('p', { class: 'askbox-status', role: 'status' });

  if (token) showDashboard();
  else showLogin();

  function showLogin(message) {
    const input = el('input', { type: 'password', class: 'askbox-link', placeholder: 'ADMIN_TOKEN', autocomplete: 'current-password', 'aria-label': 'ADMIN_TOKEN' });
    const form = el('form', { class: 'askbox-form' },
      el('p', {}, '输入部署时设置的 ADMIN_TOKEN（只保存在这个浏览器里）。'),
      el('div', { class: 'askbox-link-row' }, input, el('button', { type: 'submit', class: 'askbox-button' }, '登录')),
      message ? el('p', { class: 'askbox-status is-error' }, message) : null);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      token = input.value.trim();
      if (!token) return;
      saveToken(token);
      showDashboard();
    });
    root.replaceChildren(form);
    input.focus();
  }

  function showDashboard() {
    const logout = el('button', { type: 'button', class: 'askbox-linkbtn' }, '退出登录');
    logout.addEventListener('click', () => {
      token = null;
      saveToken(null);
      showLogin();
    });
    root.replaceChildren(el('div', { class: 'askbox-admin-bar' }, tabs, logout), status, list, el('div', { class: 'askbox-more' }, more));
    load(true);
  }

  async function load(reset) {
    if (reset) offset = 0;
    more.disabled = true;
    try {
      const data = await api('GET', `/api/admin/threads?filter=${filter}&limit=20&offset=${offset}`);
      renderTabs(data.counts);
      if (reset) list.replaceChildren();
      for (const thread of data.threads) list.append(renderThread(thread));
      if (!list.children.length) list.append(el('p', { class: 'askbox-muted' }, '这里空空如也。'));
      offset = data.nextOffset ?? offset;
      more.hidden = data.nextOffset == null;
      status.textContent = '';
      status.classList.remove('is-error');
      highlightFromHash();
    } catch (err) {
      handleError(err);
    } finally {
      more.disabled = false;
    }
  }

  function renderTabs(counts) {
    tabs.replaceChildren(...FILTERS.map(([key, label]) => {
      const tab = el('button', {
        type: 'button',
        role: 'tab',
        class: `askbox-tab${key === filter ? ' is-active' : ''}`,
        'aria-selected': String(key === filter),
      }, `${label} ${counts[key] ?? 0}`);
      tab.addEventListener('click', () => {
        filter = key;
        load(true);
      });
      return tab;
    }));
  }

  function renderThread(thread) {
    const badges = [];
    if (thread.awaitingReply && !thread.hidden) badges.push(['待回复', 'is-warn']);
    if (thread.public) badges.push(['已公开', 'is-ok']);
    if (thread.hidden) badges.push(['已隐藏', '']);
    if (thread.closed) badges.push(['已关闭追问', '']);

    const article = el('article', { class: 'askbox-thread', id: thread.id },
      el('div', { class: 'askbox-thread-meta' },
        el('time', {}, fmtDate(thread.createdAt, 'zh-CN')),
        thread.lang ? el('span', { class: 'askbox-muted' }, thread.lang) : null,
        badges.map(([label, cls]) => el('span', { class: `askbox-badge ${cls}` }, label))),
      el('div', { class: 'askbox-messages' }, thread.messages.map((m) => renderMessage(thread, m))));

    const reply = el('textarea', { class: 'askbox-input', rows: 3, placeholder: '写下你的回复（发送后这个问题和之前的对话会公开）' });
    const send = el('button', { type: 'submit', class: 'askbox-button' }, '回复并公开');
    const form = el('form', { class: 'askbox-form' }, reply, el('div', { class: 'askbox-form-row' }, el('span'), send));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = reply.value.trim();
      if (!text) return;
      run(send, () => api('POST', `/api/threads/${thread.id}/messages`, { body: { body: text } }));
    });

    const actions = el('div', { class: 'askbox-actions' },
      actionButton(thread.hidden ? '取消隐藏' : '隐藏', () =>
        api('PATCH', `/api/admin/threads/${thread.id}`, { body: { status: thread.hidden ? 'open' : 'hidden' } })),
      actionButton(thread.closed ? '重新开放追问' : '关闭追问', () =>
        api('PATCH', `/api/admin/threads/${thread.id}`, { body: { closed: !thread.closed } })),
      actionButton('删除整个问题', () => api('DELETE', `/api/admin/threads/${thread.id}`), '确定永久删除这个问题和所有对话吗？'));

    article.append(form, actions);
    return article;
  }

  function renderMessage(thread, m) {
    const body = el('div', { class: 'askbox-msg-body' }, m.body);
    const tools = el('span', { class: 'askbox-msg-tools' });
    if (m.author === 'owner') {
      tools.append(actionButton('编辑', () => editMessage(m, body, tools), null, true));
    }
    tools.append(actionButton('删除', () => api('DELETE', `/api/admin/messages/${m.id}`), '确定删除这条消息吗？'));
    return el('div', { class: `askbox-msg askbox-msg--${m.author}` },
      el('div', { class: 'askbox-msg-head' },
        el('span', { class: 'askbox-msg-who' }, m.author === 'owner' ? '我' : '提问者'),
        el('time', {}, fmtDate(m.createdAt, 'zh-CN')),
        m.edited ? el('span', { class: 'askbox-muted' }, '已编辑') : null,
        tools),
      body);
  }

  function editMessage(m, body, tools) {
    const input = el('textarea', { class: 'askbox-input', rows: 3, value: m.body });
    const save = el('button', { type: 'submit', class: 'askbox-button' }, '保存');
    const cancel = el('button', { type: 'button', class: 'askbox-button askbox-button--ghost' }, '取消');
    const form = el('form', { class: 'askbox-form' }, input, el('div', { class: 'askbox-form-row' }, cancel, save));
    cancel.addEventListener('click', () => {
      form.replaceWith(body);
      tools.hidden = false;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      run(save, () => api('PATCH', `/api/admin/messages/${m.id}`, { body: { body: input.value } }));
    });
    tools.hidden = true;
    body.replaceWith(form);
    input.focus();
  }

  // `local` actions change the page only; the rest call the API and then reload the list.
  function actionButton(label, action, confirmText, local) {
    const button = el('button', { type: 'button', class: 'askbox-linkbtn' }, label);
    button.addEventListener('click', () => {
      if (confirmText && !window.confirm(confirmText)) return;
      if (local) action();
      else run(button, action);
    });
    return button;
  }

  async function run(button, action) {
    button.disabled = true;
    try {
      await action();
      await load(true);
    } catch (err) {
      handleError(err);
    } finally {
      button.disabled = false;
    }
  }

  function handleError(err) {
    if (err.status === 401) {
      token = null;
      saveToken(null);
      showLogin('ADMIN_TOKEN 不正确。');
      return;
    }
    status.textContent = err.code === 'network' ? '连不上 API。' : `出错了：${err.code || err.message}`;
    status.classList.add('is-error');
  }

  function highlightFromHash() {
    const id = location.hash.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (target && target.classList.contains('askbox-thread')) {
      target.classList.add('is-highlighted');
      target.scrollIntoView({ block: 'center' });
    }
  }
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
