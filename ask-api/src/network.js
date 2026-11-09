// The part of a visitor's address that rate limits count by. An IPv4 address is one
// network. An IPv6 visitor usually holds a whole /64 block and can switch addresses
// inside it freely, so the block counts as one network.
export function networkOf(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return ip || 'unknown';
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/); // ::ffff:1.2.3.4
  if (v4) return v4[1];

  const [head, tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}
