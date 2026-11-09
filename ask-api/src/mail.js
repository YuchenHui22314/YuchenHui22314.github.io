// A plain-text email in the raw MIME form that Cloudflare's send_email binding takes.
// The subject and body may hold Chinese, so both are sent base64-encoded as UTF-8.
export function rawEmail({ from, fromName, to, subject, text, now = new Date(), id = crypto.randomUUID() }) {
  return [
    `From: ${encodeWord(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(text).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
}

function encodeWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64(s)}?=`;
}

function base64(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}
