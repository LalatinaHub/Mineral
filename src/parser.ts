// Pure parsing / normalization / validation helpers.
// No network, no filesystem, no side effects -> testable in isolation.

export interface NodeEntry {
  /** The link exactly as it should be written to result/nodes (remark preserved). */
  text: string;
  /** Identity used for de-duplication: scheme + auth + host:port + normalized query, remark excluded. */
  identity: string;
  scheme: string;
  host: string;
  port: number;
}

export interface SubEntry {
  text: string;
  identity: string;
}

export interface ParseReport {
  nodes: NodeEntry[];
  subs: SubEntry[];
  rejected: number;
  rejectedSamples: string[];
}

/** Schemes that carry a proxy config. Order is irrelevant: every branch requires a literal "://". */
export const NODE_SCHEMES = [
  "vmess",
  "vless",
  "trojan",
  "hysteria2",
  "hysteria",
  "hy2",
  "tuic",
  "socks5",
  "socks",
  "ssr",
  "ss",
  "snell",
  "anytls",
  "wireguard",
  "juicity",
] as const;

const NODE_SCHEME_ALT = NODE_SCHEMES.join("|");

// Some panels issue non-UUID ids, so accept any opaque credential rather than only RFC-4122 uuids.
const USERINFO_RE = /^[^\s/?#]+$/;

// Schemes that cannot work without a credential in the userinfo part.
const REQUIRES_USERINFO = new Set(["vless", "trojan", "hysteria2", "hysteria", "hy2", "tuic", "snell", "anytls", "juicity"]);

// Zero-width / BOM characters are routinely injected to break scrapers. Strip them everywhere.
const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u2060\ufeff]/g;

// Trailing decoration that is never part of a share link: markdown, quotes, brackets, list punctuation.
const TRAILING_JUNK_RE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000"'`<>)\]}|\\,;*_~]+$/;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "\u2026",
  ndash: "\u2013",
  mdash: "\u2014",
};

/** Telegram floods HTML-escaped share links ("&amp;host=") which are silently broken in clients. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripZeroWidth(input: string): string {
  return input.replace(ZERO_WIDTH_RE, "");
}

export function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (host.includes(":")) return /^[0-9a-fA-F:]{2,45}$/.test(host); // bare IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255);
  }
  // Underscores appear in real CDN hostnames, so allow them.
  return /^[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?)*\.?$/.test(host);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function b64decode(input: string): string | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const buf = Buffer.from(normalized, "base64");
    if (!buf.length) return null;
    const text = buf.toString("utf8");
    if (text.includes("\ufffd")) return null; // not valid UTF-8 -> not a real config
    return text;
  } catch {
    return null;
  }
}

function decodeMaybe(input: string): string {
  if (!input.includes("%")) return input;
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/**
 * Normalize a query string so that identical configs written with different parameter
 * order or percent-escape casing collapse to one identity.
 */
export function normalizeQuery(query: string): string {
  if (!query) return "";
  return query
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part.toLowerCase();
      const key = part.slice(0, eq).toLowerCase();
      const value = part
        .slice(eq + 1)
        .replace(/%[0-9a-fA-F]{2}/g, (esc) => esc.toUpperCase());
      return `${key}=${value}`;
    })
    .sort()
    .join("&");
}

interface Dissected {
  scheme: string;
  authority: string;
  query: string;
  fragment: string;
}

function dissect(candidate: string): Dissected | null {
  const schemeEnd = candidate.indexOf("://");
  if (schemeEnd <= 0) return null;
  const scheme = candidate.slice(0, schemeEnd).toLowerCase();
  let rest = candidate.slice(schemeEnd + 3);
  let fragment = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let query = "";
  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) {
    query = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }
  return { scheme, authority: rest, query, fragment };
}

interface Authority {
  userinfo: string;
  host: string;
  port: number;
  path: string;
}

/** Parse "[userinfo@]host:port[/path]". The path is kept because it can carry a working config. */
function parseAuthority(authority: string): Authority | null {
  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0 ? authority.slice(0, at) : "";
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;

  const bracketed = hostPart.match(/^\[([0-9a-fA-F:.]+)\]:(\d{1,5})(\/.*)?$/);
  const plain = bracketed ? null : hostPart.match(/^([^:/]+):(\d{1,5})(\/.*)?$/);
  const match = bracketed ?? plain;
  if (!match) return null;

  const host = match[1];
  const port = Number(match[2]);
  const path = match[3] ?? "";
  if (!isValidHost(host) || !isValidPort(port)) return null;
  return { userinfo: decodeMaybe(userinfo), host: host.toLowerCase(), port, path };
}

function authorityIdentity(authority: Authority): string {
  return `${authority.host}:${authority.port}${authority.path}`;
}

/** vmess stores the whole config as a JSON blob; `ps` is only the remark, so it must not join the identity. */
function normalizeVmess(json: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(json).sort()) {
    if (key === "ps" || key === "remark" || key === "remarks" || key === "name") continue;
    const value = json[key];
    out[key] = key === "port" || key === "aid" ? String(value).trim() : value;
  }
  return JSON.stringify(out);
}

function parseVmess(candidate: string): NodeEntry | null {
  const body = candidate.slice("vmess://".length);
  let json: Record<string, unknown> | null = null;
  const decoded = b64decode(body);
  if (decoded) {
    try {
      json = JSON.parse(decoded);
    } catch {
      /* not JSON */
    }
  }
  if (!json && body.trimStart().startsWith("{")) {
    try {
      json = JSON.parse(body);
    } catch {
      /* not JSON */
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;

  const host = String(json.add ?? "").replace(/^\[|\]$/g, "");
  const port = Number(String(json.port ?? "").trim());
  const id = String(json.id ?? "").trim();
  if (!isValidHost(host) || !isValidPort(port) || !id) return null;

  return {
    text: candidate,
    identity: `vmess|${id}|${host.toLowerCase()}:${port}|${normalizeVmess(json)}`,
    scheme: "vmess",
    host,
    port,
  };
}

function parseShadowsocks(candidate: string, parts: Dissected): NodeEntry | null {
  // SIP002: ss://<base64(method:password)@host:port>   (userinfo may also be plain "method:password")
  const sip002 = parseAuthority(parts.authority);
  if (sip002?.userinfo) {
    const auth = b64decode(sip002.userinfo) ?? decodeMaybe(sip002.userinfo);
    if (!auth || !auth.includes(":")) return null;
    return {
      text: candidate,
      identity: `ss|${auth}|${authorityIdentity(sip002)}|${normalizeQuery(parts.query)}`,
      scheme: "ss",
      host: sip002.host,
      port: sip002.port,
    };
  }
  // Legacy: ss://<base64(method:password@host:port)>
  const decoded = b64decode(parts.authority);
  if (!decoded) return null;
  const inner = decoded.split("#")[0].split("?")[0];
  const at = inner.lastIndexOf("@");
  if (at < 0) return null;
  const auth = inner.slice(0, at);
  const hostPort = inner.slice(at + 1).match(/^([^:/]+):(\d{1,5})$/);
  if (!auth.includes(":") || !hostPort) return null;
  const host = hostPort[1].toLowerCase();
  const port = Number(hostPort[2]);
  if (!isValidHost(host) || !isValidPort(port)) return null;
  return {
    text: candidate,
    identity: `ss|${auth}|${host}:${port}|${normalizeQuery(parts.query)}`,
    scheme: "ss",
    host,
    port,
  };
}

function parseShadowsocksR(candidate: string): NodeEntry | null {
  const decoded = b64decode(candidate.slice("ssr://".length));
  if (!decoded) return null;
  // host:port:protocol:method:obfs:base64(password)[/?params]
  const main = decoded.split("/?")[0];
  const fields = main.split(":");
  if (fields.length < 6) return null;
  const host = fields[0];
  const port = Number(fields[1]);
  if (!isValidHost(host) || !isValidPort(port)) return null;
  return {
    text: candidate,
    identity: `ssr|${main}`,
    scheme: "ssr",
    host,
    port,
  };
}

function parseAuthorityScheme(candidate: string, parts: Dissected): NodeEntry | null {
  const authority = parseAuthority(parts.authority);
  if (!authority) return null;

  if (REQUIRES_USERINFO.has(parts.scheme) && !USERINFO_RE.test(authority.userinfo)) return null;

  return {
    text: candidate,
    identity: `${parts.scheme}|${authority.userinfo}|${authorityIdentity(authority)}|${normalizeQuery(parts.query)}`,
    scheme: parts.scheme,
    host: authority.host,
    port: authority.port,
  };
}

/** Trim decoration that follows a link and decode entities. Returns null if nothing usable is left. */
export function cleanCandidate(segment: string): string | null {
  let value = decodeEntities(stripZeroWidth(segment));
  value = value.replace(TRAILING_JUNK_RE, "");
  value = value.trim();
  return value.length > 0 ? value : null;
}

export function parseNode(candidate: string): NodeEntry | null {
  const parts = dissect(candidate);
  if (!parts) return null;
  if (!(NODE_SCHEMES as readonly string[]).includes(parts.scheme)) return null;

  switch (parts.scheme) {
    case "vmess":
      return parseVmess(candidate);
    case "ss":
      return parseShadowsocks(candidate, parts);
    case "ssr":
      return parseShadowsocksR(candidate);
    default:
      return parseAuthorityScheme(candidate, parts);
  }
}

// ---------------------------------------------------------------- subscription links

const SUB_KEYWORD_RE =
  /(sub|clash|sing-?box|v2ray|v2-?ray|xray|config|prox|node|vmess|vless|trojan|shadowsocks|ssr?|token|api|paste|gist|raw\.githubusercontent|subscribe|mirror|backup|cdn|free)/i;

const SUB_REJECT_HOST_RE = /(^|\.)(t\.me|telegram\.org|telegram\.me|telegram\.dog|telesco\.pe|youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com)$/i;

// Extensions that unambiguously hold a subscription payload.
const SUB_FILE_EXT_RE = /\.(txt|ya?ml|json|conf|ini|b64|base64|v2ray|nodes?|list)$/i;

const SUB_REJECT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|mp4|mkv|webm|mp3|zip|rar|7z|tar|gz|apk|exe|msi|dmg|iso|pdf|docx?|xlsx?|pptx?)$/i;

const URL_RE = /https?:\/\/[^\s\u00a0"'`<>)\]}|,;\\]+/g;

/** Canonical form used only for de-duplication, so mirror spellings of one URL collapse. */
export function normalizeSubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(/\/+$/, "")
      .replace(/\/refs\/(heads|tags)\//, "/");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function parseSubUrl(candidate: string): SubEntry | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (SUB_REJECT_HOST_RE.test(host)) return null;
  if (SUB_REJECT_FILE_EXT_RE.test(url.pathname)) return null;
  // The URL must look like a subscription endpoint, not a random post link.
  const looksLikeSub = SUB_KEYWORD_RE.test(`${host}${url.pathname}`) || SUB_FILE_EXT_RE.test(url.pathname);
  if (!looksLikeSub) return null;
  return { text: candidate, identity: normalizeSubUrl(candidate) };
}

// ---------------------------------------------------------------- entry point

function schemeOffsets(line: string): number[] {
  const re = new RegExp(`(?:${NODE_SCHEME_ALT})://`, "g");
  const offsets: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) offsets.push(match.index);
  return offsets;
}

/**
 * Extract every node and subscription link from a raw message body.
 * Lines are segmented at each scheme occurrence, so several links sharing one line
 * (comma/space separated) are all recovered instead of being glued into one broken entry.
 */
export function parseText(text: string): ParseReport {
  const nodes = new Map<string, NodeEntry>();
  const subs = new Map<string, SubEntry>();
  const rejectedSamples: string[] = [];
  let rejected = 0;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = stripZeroWidth(rawLine);
    if (!line.includes("://")) continue;

    const offsets = schemeOffsets(line);
    for (let i = 0; i < offsets.length; i++) {
      const end = i + 1 < offsets.length ? offsets[i + 1] : undefined;
      const segment = line.slice(offsets[i], end);
      const candidate = cleanCandidate(segment);
      if (!candidate) continue;
      const node = parseNode(candidate);
      if (node) {
        if (!nodes.has(node.identity)) nodes.set(node.identity, node);
      } else {
        rejected++;
        if (rejectedSamples.length < 10) rejectedSamples.push(candidate.slice(0, 120));
      }
    }

    URL_RE.lastIndex = 0;
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = URL_RE.exec(line)) !== null) {
      const candidate = cleanCandidate(urlMatch[0]);
      if (!candidate) continue;
      const sub = parseSubUrl(candidate);
      if (sub && !subs.has(sub.identity)) subs.set(sub.identity, sub);
    }
  }

  return { nodes: [...nodes.values()], subs: [...subs.values()], rejected, rejectedSamples };
}

export function parseNodeText(text: string): NodeEntry | null {
  const line = stripZeroWidth(text);
  const offsets = schemeOffsets(line);
  if (!offsets.length) return null;
  const candidate = cleanCandidate(line.slice(offsets[0]));
  return candidate ? parseNode(candidate) : null;
}

export function parseSubText(text: string): SubEntry | null {
  const candidate = cleanCandidate(text);
  return candidate ? parseSubUrl(candidate) : null;
}
