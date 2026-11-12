/**
 * Guard for fetching a URL a user pasted: which URLs and which resolved
 * addresses a server may touch. Pure — no DNS, no network, no imports — so
 * the rules can be tested exhaustively; api/product.ts does the resolving.
 */

/** Dotted-decimal IPv4 → four octets, or null. */
export function parseIPv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return [o[0], o[1], o[2], o[3]];
}

function publicIPv4(o: readonly number[]): boolean {
  const [a, b, c] = o;
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** IPv6 text (with `::` and an optional dotted IPv4 tail) → 16 bytes, or null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s || s.includes('%') || !/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a:b:1.2.3.4" leaves "a:b:" — drop the single joining colon
    if (!s.endsWith('::')) s = s.slice(0, -1);
  } else if (s.includes('.')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const n = parseInt(g, 16);
      out.push(n >> 8, n & 0xff);
    }
    return out;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 14) return null;
    return [...head, ...new Array<number>(16 - known).fill(0), ...rest, ...tail];
  }
  return known === 16 ? [...head, ...tail] : null;
}

function publicIPv6(b: readonly number[]): boolean {
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  // ::, ::1 and the deprecated IPv4-compatible block ::/96
  if (zero(0, 12)) return false;
  // IPv4-mapped ::ffff:a.b.c.d — judge the IPv4 address inside
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return publicIPv4(b.slice(12));
  // NAT64 64:ff9b::/96 — likewise
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return publicIPv4(b.slice(12));
  // 6to4 2002:AABB:CCDD::/48 embeds an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x02) return publicIPv4(b.slice(2, 6));
  // Teredo 2001:0000::/32 and documentation 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return false;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;
  if ((b[0] & 0xfe) === 0xfc) return false; // unique local fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return false; // site-local fec0::/10
  if (b[0] === 0xff) return false; // multicast
  // only global unicast 2000::/3 is routable on the public internet
  return (b[0] & 0xe0) === 0x20;
}

/** True only for an address on the public internet (IPv4 or IPv6 text). */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip.trim());
  if (v4) return publicIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return publicIPv6(v6);
  return false; // unparseable: refuse
}

export type UrlRefusal = 'bad-url' | 'https-only' | 'unsafe-host';

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRefusal };

/**
 * Is this a URL the server may request? https on the default port, a real
 * public-looking hostname (never an IP literal, localhost or an internal
 * suffix), no credentials. The resolved addresses still have to pass
 * `isPublicAddress` — a public name can point at a private address.
 */
export function checkFetchUrl(raw: string | URL): UrlCheck {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: url.protocol === 'http:' ? 'https-only' : 'bad-url' };
  if (url.username || url.password) return { ok: false, reason: 'unsafe-host' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'unsafe-host' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) return { ok: false, reason: 'bad-url' };
  // IP literals (the URL parser has already normalised 0x7f.1, 2130706433, [::1] …)
  if (parseIPv4(host) || host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'unsafe-host' };
  if (/^\d+(\.\d+)*$/.test(host)) return { ok: false, reason: 'unsafe-host' };
  if (!host.includes('.')) return { ok: false, reason: 'unsafe-host' }; // "localhost", "metadata", bare intranet names
  if (/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa)$/.test(host)) {
    return { ok: false, reason: 'unsafe-host' };
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return { ok: false, reason: 'unsafe-host' };
  return { ok: true, url };
}
