import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Whether this runtime has a filesystem worth consulting.
 *
 * Cloudflare Workers has no real filesystem; probing for a sites.json there is
 * pointless and, depending on the compatibility shims, can throw. Configuration
 * arrives through the environment instead.
 */
function hasFilesystem(): boolean {
  try {
    return typeof process !== "undefined" && Boolean(process.versions?.node) && typeof fs.existsSync === "function";
  } catch {
    return false;
  }
}

export interface SiteConfig {
  /** Stable identifier used as `site_id` in every tool. */
  id: string;
  /** Human readable label. */
  name: string;
  /** Base site URL, no trailing slash, e.g. https://example.com */
  url: string;
  /** WordPress username (used with an Application Password). */
  username?: string;
  /** Application Password (Users -> Profile -> Application Passwords). */
  appPassword?: string;
  /** Alternative: a bearer token (JWT plugins, or a reverse proxy that injects auth). */
  bearerToken?: string;
  /** REST route prefix. Defaults to /wp-json. Use ?rest_route= style for sites without pretty permalinks. */
  restPrefix?: string;
  /** Extra headers merged into every request (e.g. Cloudflare Access, basic-auth staging gates). */
  headers?: Record<string, string>;
  /** Allow self-signed certificates (staging boxes). */
  allowInsecureTLS?: boolean;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Namespace of the wpxmcp companion plugin, if installed. */
  helperNamespace?: string;
  /** Default to true. Set false to make this site read-only (all writes are refused). */
  writable?: boolean;
}

export interface ResolvedConfig {
  sites: SiteConfig[];
  defaultSiteId: string | null;
  source: string;
}

function normalizeUrl(raw: string, siteId: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`Site "${siteId}" has an invalid url "${raw}". Use the site's home address, e.g. https://example.com.`);
  }
  // The REST prefix is added per request, so a pasted ".../wp-json" would double
  // up. A query string or fragment has no meaning on a base URL either.
  const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/wp-json$/i, "");
  return `${parsed.origin}${pathname}`;
}

/**
 * Reads a boolean that may arrive as a JSON boolean or as a string from an
 * environment variable. `Boolean("false")` is true, which would silently make a
 * site meant to be read-only writable.
 */
function parseBool(value: unknown, fallback: boolean, field: string, siteId: string): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new Error(`Site "${siteId}" has ${field}: ${JSON.stringify(value)}, which is not a boolean. Use true or false.`);
}

/** JSON.parse messages quote the offending input, which may be a password. Keep only the position. */
function describeJsonError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const position = /position (\d+)/.exec(message);
  return position ? `invalid JSON near position ${position[1]}` : "invalid JSON";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function coerceSite(raw: any, fallbackId: string): SiteConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Site "${fallbackId}" is not an object.`);
  }
  const url = raw.url ?? raw.site_url ?? raw.siteUrl;
  if (!url || typeof url !== "string") {
    throw new Error(`Site "${fallbackId}" is missing a "url".`);
  }
  const id = String(raw.id ?? fallbackId ?? slugify(url));
  const normalized = normalizeUrl(url, id);
  const timeoutMs = Number(raw.timeoutMs ?? raw.timeout_ms ?? 60000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // setTimeout treats NaN as ~1ms, so every request would time out at once.
    throw new Error(`Site "${id}" has timeoutMs: ${JSON.stringify(raw.timeoutMs ?? raw.timeout_ms)}, which is not a positive number of milliseconds.`);
  }
  let restPrefix: string = raw.restPrefix ?? raw.rest_prefix ?? "/wp-json";
  if (!restPrefix.startsWith("/")) restPrefix = `/${restPrefix}`;
  return {
    id,
    name: String(raw.name ?? raw.label ?? id),
    url: normalized,
    username: raw.username ?? raw.user ?? undefined,
    appPassword: raw.appPassword ?? raw.app_password ?? raw.password ?? undefined,
    bearerToken: raw.bearerToken ?? raw.bearer_token ?? raw.token ?? undefined,
    restPrefix,
    headers: raw.headers ?? undefined,
    allowInsecureTLS: parseBool(raw.allowInsecureTLS ?? raw.allow_insecure_tls, false, "allowInsecureTLS", id),
    timeoutMs,
    helperNamespace: raw.helperNamespace ?? raw.helper_namespace ?? "wpxmcp/v1",
    writable: parseBool(raw.writable, true, "writable", id),
  };
}

/**
 * Config resolution order (first match wins for the site list):
 *   1. WPX_SITES            — inline JSON (array or {sites:[...]})
 *   2. WPX_SITES_FILE       — path to a JSON file
 *   3. ~/.wpxmcp/sites.json / ./wpxmcp.sites.json
 *   4. WP_SITE_<ID>_URL / _USERNAME / _APP_PASSWORD env triples
 *   5. WORDPRESS_URL / WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD (single site)
 */
export function loadConfig(env: NodeJS.ProcessEnv = (typeof process !== "undefined" ? process.env : {}) as NodeJS.ProcessEnv): ResolvedConfig {
  const collected: { sites: SiteConfig[]; source: string } | null =
    fromInlineJson(env) ?? fromFile(env) ?? fromWellKnownFiles() ?? fromIndexedEnv(env) ?? fromSingleEnv(env);

  const sites = collected?.sites ?? [];
  const source = collected?.source ?? "none";

  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.id)) throw new Error(`Duplicate site id "${s.id}" in ${source}.`);
    seen.add(s.id);
  }

  let defaultSiteId = env.WPX_DEFAULT_SITE ?? env.WORDPRESS_DEFAULT_SITE ?? null;
  if (defaultSiteId && !seen.has(defaultSiteId)) {
    throw new Error(`WPX_DEFAULT_SITE="${defaultSiteId}" does not match any configured site (${[...seen].join(", ") || "none"}).`);
  }
  if (!defaultSiteId && sites.length > 0) defaultSiteId = sites[0].id;

  return { sites, defaultSiteId, source };
}

function parseSiteCollection(parsed: any, source: string): { sites: SiteConfig[]; source: string } {
  let list: any[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (Array.isArray(parsed?.sites)) {
    list = parsed.sites;
  } else if (parsed && typeof parsed === "object") {
    // Map form: { "blog": { url, username, ... } }
    list = Object.entries(parsed).map(([id, value]) => ({ id, ...(value as object) }));
  } else {
    throw new Error(`${source} must be a JSON array, {"sites":[...]}, or an object map of sites.`);
  }
  return { sites: list.map((s, i) => coerceSite(s, s?.id ?? `site-${i + 1}`)), source };
}

function fromInlineJson(env: NodeJS.ProcessEnv) {
  if (!env.WPX_SITES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.WPX_SITES);
  } catch (e) {
    throw new Error(`Could not parse WPX_SITES: ${describeJsonError(e)}.`);
  }
  try {
    return parseSiteCollection(parsed, "WPX_SITES");
  } catch (e: any) {
    throw new Error(`Could not parse WPX_SITES: ${e.message}`);
  }
}

function readJsonFile(file: string, source: string) {
  const text = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${describeJsonError(e)}.`);
  }
  try {
    return parseSiteCollection(parsed, source);
  } catch (e: any) {
    throw new Error(`Could not parse ${file}: ${e.message}`);
  }
}

function fromFile(env: NodeJS.ProcessEnv) {
  const file = env.WPX_SITES_FILE;
  if (!file) return null;
  if (!hasFilesystem()) {
    throw new Error(
      `WPX_SITES_FILE is set to "${file}", but this runtime has no filesystem. On Cloudflare Workers, put the site list in the WPX_SITES secret instead.`
    );
  }
  const resolved = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`WPX_SITES_FILE points at "${resolved}" which does not exist.`);
  return readJsonFile(resolved, `WPX_SITES_FILE (${resolved})`);
}

function fromWellKnownFiles() {
  if (!hasFilesystem()) return null;
  const candidates = [
    path.join(os.homedir(), ".wpxmcp", "sites.json"),
    path.join(process.cwd(), "wpxmcp.sites.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return readJsonFile(c, c);
  }
  return null;
}

function fromIndexedEnv(env: NodeJS.ProcessEnv) {
  const ids = new Set<string>();
  for (const key of Object.keys(env)) {
    const m = /^WP_SITE_([A-Z0-9_]+)_URL$/.exec(key);
    if (m) ids.add(m[1]);
  }
  if (ids.size === 0) return null;
  const sites = [...ids].map((raw) => {
    const p = `WP_SITE_${raw}_`;
    return coerceSite(
      {
        id: raw.toLowerCase().replace(/_/g, "-"),
        name: env[p + "NAME"] ?? raw,
        url: env[p + "URL"],
        username: env[p + "USERNAME"],
        appPassword: env[p + "APP_PASSWORD"] ?? env[p + "PASSWORD"],
        bearerToken: env[p + "TOKEN"],
        restPrefix: env[p + "REST_PREFIX"],
        allowInsecureTLS: env[p + "ALLOW_INSECURE_TLS"] === "true",
        writable: env[p + "READONLY"] === "true" ? false : true,
      },
      raw.toLowerCase()
    );
  });
  return { sites, source: "WP_SITE_* environment variables" };
}

function fromSingleEnv(env: NodeJS.ProcessEnv) {
  const url = env.WORDPRESS_URL ?? env.WP_URL;
  if (!url) return null;
  return {
    sites: [
      coerceSite(
        {
          id: env.WORDPRESS_SITE_ID ?? "default",
          name: env.WORDPRESS_SITE_NAME ?? "default",
          url,
          username: env.WORDPRESS_USERNAME ?? env.WP_USERNAME,
          appPassword: env.WORDPRESS_APP_PASSWORD ?? env.WP_APP_PASSWORD ?? env.WORDPRESS_PASSWORD,
          bearerToken: env.WORDPRESS_TOKEN,
          restPrefix: env.WORDPRESS_REST_PREFIX,
          allowInsecureTLS: env.WORDPRESS_ALLOW_INSECURE_TLS === "true",
        },
        "default"
      ),
    ],
    source: "WORDPRESS_* environment variables",
  };
}
