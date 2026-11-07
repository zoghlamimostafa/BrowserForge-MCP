import { isIP } from 'node:net';

/** Which addresses count as "public". Everything that is loopback, private, link-local, shared, reserved, documentation or multicast does not. */

function v4Parts(ip: string): number[] | undefined {
  const p = ip.split('.');
  if (p.length !== 4) return undefined;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined;
}

function publicV4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast + reserved + broadcast
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol + documentation
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Eight 16-bit groups of an IPv6 address, or undefined when it is not valid. Accepts "::" and an embedded IPv4 tail. */
function v6Groups(input: string): number[] | undefined {
  let s = input.split('%')[0]!.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const q = v4Parts(tail[1]!);
    if (!q) return undefined;
    s = s.slice(0, -tail[1]!.length) + ((q[0]! << 8) | q[1]!).toString(16) + ':' + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0)) return undefined;
  const all = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

function publicV6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => publicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.every((x) => x === 0)) return false; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return false; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded(g6, g7); // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return false; // ::a.b.c.d (deprecated IPv4-compatible)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // NAT64
  if (g0 === 0x2002) return embedded(g1, g2); // 6to4 carries an IPv4 address
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** True only for a public unicast IPv4 or IPv6 address. Anything that does not parse is refused. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const kind = isIP(ip.split('%')[0]!);
  if (kind === 4) { const p = v4Parts(ip); return p ? publicV4(p) : false; }
  if (kind === 6) { const g = v6Groups(ip); return g ? publicV6(g) : false; }
  return false;
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa'];

/** Why a URL hostname (as `URL.hostname` gives it) can never be public, or undefined when it may be. A name is only judged by its spelling here; the address it resolves to is checked at request time. */
export function localHostReason(hostname: string): string | undefined {
  const h = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!h) return 'empty host';
  if (isIP(h.split('%')[0]!)) return isPublicAddress(h) ? undefined : 'a loopback, private or link-local address';
  if (h === 'localhost' || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return 'a local name';
  if (!h.includes('.')) return 'a name with no domain (it can only be on your own network)';
  return undefined;
}
