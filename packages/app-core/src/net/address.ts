import dns from "node:dns/promises";
import net from "node:net";

const LOCAL_HOST_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i;

/** Strips trailing FQDN dots and IPv6 brackets, lowercased. */
export function normalizeHostname(hostname: string): string {
  return hostname.replace(/\.+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

/** True for empty names, single-label hostnames, and local/mDNS/intranet suffixes (including trailing-dot forms). */
export function isLocalHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return !host || !host.includes(".") || LOCAL_HOST_NAME.test(host);
}

function isPrivateIpv4(a: number, b: number, c: number, allowTunnelRanges: boolean): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (!allowTunnelRanges) {
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }
  return false;
}

/** Expands any valid IPv6 literal (compressed, leading-zero, or embedded IPv4) into 8 unsigned 16-bit hextets. */
function expandIpv6(raw: string): number[] | null {
  let addr = raw;
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4 = addr.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  let parts: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    parts = addr.split(":");
    if (parts.length !== 8) return null;
  }
  const out: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out.push(parseInt(part, 16));
  }
  return out;
}

/**
 * Whether an IP address is loopback, private, link-local, unique-local, multicast, documentation, or reserved.
 * When `allowTunnelRanges` is true (for declared HTTPS provider hosts), TUN Fake-IP (`198.18.0.0/15`) and CGNAT (`100.64.0.0/10`) are allowed.
 */
export function isPrivateAddress(address: string, options: { allowTunnelRanges?: boolean } = {}): boolean {
  const allowTunnelRanges = options.allowTunnelRanges ?? false;
  const cleaned = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  const version = net.isIP(cleaned);
  if (version === 4) {
    const [a, b, c] = cleaned.split(".").map(Number) as [number, number, number, number];
    return isPrivateIpv4(a, b, c, allowTunnelRanges);
  }
  if (version === 6) {
    const h = expandIpv6(cleaned);
    if (!h) return true;
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number];
    // Unspecified (::) and loopback (::1)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) return true;
    // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), and IPv4-translated (::ffff:0:0:0/96)
    const isV4Embedded =
      (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0)) ||
      (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0);
    if (isV4Embedded) {
      return isPrivateIpv4(h6 >> 8, h6 & 0xff, h7 >> 8, allowTunnelRanges);
    }
    // 6to4 (2002::/16) carrying a private IPv4 address
    if (h0 === 0x2002) {
      return isPrivateIpv4(h1 >> 8, h1 & 0xff, h2 >> 8, allowTunnelRanges);
    }
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if (h0 === 0x0064 && h1 === 0xff9b && ((h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) || h2 === 0x0001)) return true;
    // Discard-only (100::/64)
    if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
    // Documentation (2001:db8::/32) and Teredo (2001::/32)
    if (h0 === 0x2001 && (h1 === 0x0db8 || h1 === 0x0000)) return true;
    // Unique local (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10), multicast (ff00::/8)
    if ((h0 & 0xfe00) === 0xfc00) return true;
    if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true;
    if ((h0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

export async function defaultLookup(host: string): Promise<string[]> {
  return (await dns.lookup(host, { all: true })).map((entry) => entry.address);
}
