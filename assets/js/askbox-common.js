// Shared helpers for the Q&A box page and its admin page.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createApi(base, defaultHeaders = () => ({})) {
  const root = base.replace(/\/+$/, '');
  return async function call(method, path, { body, token } = {}) {
    const headers = { ...defaultHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Asker-Token'] = token;
    let res;
    try {
      res = await fetch(root + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('network', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'generic', res.status);
    return data;
  };
}

export function fmtDate(ms, locale) {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms);
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}
