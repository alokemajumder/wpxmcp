import { platform } from "./platform.js";
import type { SiteConfig } from "./config.js";
import { WPError, hintForFailure } from "./errors.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, unknown>;
  body?: unknown;
  /** Raw binary body (media uploads). */
  raw?: { data: Uint8Array; contentType: string; filename: string };
  /** Absolute route including namespace, e.g. "/wp/v2/posts". */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface WPResponse<T = any> {
  data: T;
  status: number;
  headers: Headers;
  /** X-WP-Total when the endpoint paginates. */
  total?: number;
  totalPages?: number;
}

const USER_AGENT = "wpxmcp/2.0 (+https://github.com/alokemajumder/wpxmcp)";

/** UTF-8 safe base64 encode that works on both Node and Workers. */
function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Transient statuses worth retrying. 500 is excluded: it is usually a real PHP fatal. */
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

/** Connection-level failures that are worth another attempt. */
const RETRYABLE_NETWORK = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN",
  "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;

/** A PHP warning printed ahead of the JSON when display_errors is on. */
const PHP_NOTICE = /^\s*(?:<br\s*\/?>\s*)?(?:<b>)?(?:PHP )?(?:Warning|Notice|Deprecated|Strict Standards|Fatal error)(?:<\/b>)?:[\s\S]*? on line (?:<b>)?\d+(?:<\/b>)?(?:<br\s*\/?>)?/i;

/**
 * Decodes a response body. JSON is recovered even when PHP notices precede it —
 * with display_errors on they are printed before WordPress sends its headers,
 * which also downgrades the Content-Type to text/html. Anything else stays text.
 */
function parseBody(text: string, contentType: string): unknown {
  let candidate = text;
  while (PHP_NOTICE.test(candidate)) candidate = candidate.replace(PHP_NOTICE, "");
  const trimmed = candidate.trim();
  if (contentType.includes("json") || candidate !== text || /^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON after all */
    }
  }
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before the next attempt.
 *
 * Honours Retry-After when the server sends one — a rate limiter knows better
 * than we do — otherwise exponential backoff with jitter so a fleet of clients
 * does not retry in lockstep.
 */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 10_000);
  }
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base, 4000) + Math.floor(Math.random() * 200);
}

export class WordPressClient {
  private insecureAgent?: unknown;
  private typeCache?: { at: number; data: any };
  private taxonomyCache?: { at: number; data: any };
  private routeCache?: { at: number; namespaces: string[]; routes: string[] };

  constructor(public readonly site: SiteConfig) {}

  get baseUrl(): string {
    return this.site.url;
  }

  /** Builds the full REST URL, supporting both pretty and ?rest_route= sites. */
  buildUrl(route: string, query?: Record<string, unknown>): string {
    // A route may carry its own query string ("/wp/v2/posts?status=draft"). It
    // must be split off first: in ?rest_route= mode it would otherwise be encoded
    // into the rest_route value and the site would answer rest_no_route.
    const queryAt = route.indexOf("?");
    const path = queryAt === -1 ? route : route.slice(0, queryAt);
    const inlineQuery = queryAt === -1 ? "" : route.slice(queryAt + 1);
    const clean = path.startsWith("/") ? path : `/${path}`;
    const prefix = this.site.restPrefix ?? "/wp-json";
    let url: URL;
    if (prefix.includes("rest_route")) {
      url = new URL(this.site.url + "/");
      url.searchParams.set("rest_route", clean);
    } else {
      url = new URL(this.site.url + prefix.replace(/\/+$/, "") + clean);
    }
    for (const [key, value] of new URLSearchParams(inlineQuery)) {
      if (key !== "rest_route") url.searchParams.append(key, value);
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
          if (value.length === 0) continue;
          url.searchParams.set(key, value.join(","));
        } else if (typeof value === "boolean") {
          url.searchParams.set(key, value ? "true" : "false");
        } else if (typeof value === "object") {
          url.searchParams.set(key, JSON.stringify(value));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.site.headers ?? {}) };
    if (this.site.bearerToken) {
      headers["Authorization"] = `Bearer ${this.site.bearerToken}`;
    } else if (this.site.username && this.site.appPassword) {
      // Application Passwords are displayed with spaces; WordPress accepts them either way.
      const token = encodeBase64(`${this.site.username}:${this.site.appPassword}`);
      headers["Authorization"] = `Basic ${token}`;
    }
    return headers;
  }

  /**
   * Node only. Workers has no undici Agent, and its fetch already rejects bad
   * certificates without an opt-out, so allowInsecureTLS is a no-op there.
   */
  private async dispatcher(): Promise<unknown> {
    if (!this.site.allowInsecureTLS) return undefined;
    if (platform().kind !== "node") return undefined;
    if (!this.insecureAgent) {
      try {
        const { Agent } = await import("undici");
        this.insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
      } catch {
        return undefined;
      }
    }
    return this.insecureAgent;
  }

  hasCredentials(): boolean {
    return Boolean(this.site.bearerToken || (this.site.username && this.site.appPassword));
  }

  assertWritable(action: string) {
    if (this.site.writable === false) {
      throw new Error(
        `Site "${this.site.id}" is configured read-only (writable: false), so "${action}" was refused. Flip writable to true in the site config to allow writes.`
      );
    }
    if (!this.hasCredentials()) {
      throw new Error(
        `Site "${this.site.id}" has no credentials configured, so "${action}" cannot be authenticated. Add username + appPassword (Application Password) or a bearerToken.`
      );
    }
  }

  /**
   * Performs a request, retrying transient failures.
   *
   * Only reads are retried. Replaying a POST could create a second post or run
   * a mutation twice, and no amount of backoff makes that acceptable — a failed
   * write is reported so the caller can decide.
   */
  async request<T = any>(route: string, options: RequestOptions = {}): Promise<WPResponse<T>> {
    const method = options.method ?? "GET";
    const idempotent = method === "GET";

    let lastError: unknown;
    for (let attempt = 1; attempt <= (idempotent ? MAX_ATTEMPTS : 1); attempt++) {
      try {
        return await this.attempt<T>(route, options, method);
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS || !idempotent) break;

        // Timeouts are deliberately not retried. A timeout means the server
        // accepted the connection and is simply slow, so another attempt rarely
        // helps and multiplies the wait — three 60s attempts would exceed the
        // Worker's own request budget. Connection-level failures are different:
        // those are worth one more try.
        const retryable =
          error instanceof WPError &&
          (RETRYABLE_STATUS.has(error.status) ||
            (error.status === 0 && error.code !== "timeout" && RETRYABLE_NETWORK.has(String(error.code))));
        if (!retryable) break;

        const wait = backoffMs(attempt, (error as WPError).retryAfter ?? null);
        await sleep(wait);
      }
    }
    throw lastError;
  }

  private async attempt<T = any>(route: string, options: RequestOptions, method: NonNullable<RequestOptions["method"]>): Promise<WPResponse<T>> {
    const url = this.buildUrl(route, options.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...this.authHeaders(),
      ...(options.headers ?? {}),
    };

    let body: any;
    if (options.raw) {
      headers["Content-Type"] = options.raw.contentType;
      headers["Content-Disposition"] = `attachment; filename="${sanitizeFilename(options.raw.filename)}"`;
      body = options.raw.data;
    } else if (options.body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const timeoutMs = options.timeoutMs ?? this.site.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const dispatcher = await this.dispatcher();

    // The timer spans the whole exchange, body included: a server that sends
    // headers and then stalls would otherwise hang the call indefinitely.
    let res: Response;
    let text: string;
    try {
      let current = url;
      for (let hop = 0; ; hop++) {
        // Redirects are followed by hand. fetch's automatic handling turns a
        // redirected POST into a body-less GET — a write that silently becomes a
        // read and reports success — and forwards custom site headers (Access
        // tokens, staging gates) to whatever origin the Location names.
        res = await fetch(current, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
          // @ts-expect-error undici-specific option, honoured by Node's global fetch
          dispatcher,
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) break;

        const next = new URL(location, current);
        const sameOrigin = next.origin === new URL(current).origin;
        const keepsMethod = res.status === 307 || res.status === 308 || method === "GET";
        await res.body?.cancel().catch(() => undefined);
        if (!sameOrigin || !keepsMethod || hop >= MAX_REDIRECTS) {
          throw new WPError(
            `The site redirected ${method} ${current} to ${next.toString()} (HTTP ${res.status}), so the request was stopped.`,
            res.status, "redirect", url, method, undefined,
            !sameOrigin
              ? "The redirect leads to a different origin, where credentials are not sent. Set this site's url to the address WordPress actually answers on — usually the https:// or www. form."
              : hop >= MAX_REDIRECTS
                ? "Too many redirects — the site is probably redirecting in a loop."
                : `Following it would turn this ${method} into a GET and drop its body. Check the site url and restPrefix — typically a trailing-slash or permalink rule is rewriting REST requests.`
          );
        }
        current = next.toString();
      }
      text = await res.text();
    } catch (e: any) {
      if (e instanceof WPError) throw e;
      if (e?.name === "AbortError" || controller.signal.aborted) {
        throw new WPError(`Request timed out after ${timeoutMs}ms.`, 0, "timeout", url, method, undefined,
          "Raise timeoutMs for this site, or narrow the request (smaller per_page, fewer fields).");
      }
      const cause = e?.cause?.code ?? e?.code;
      throw new WPError(
        `Network error: ${e?.message ?? String(e)}${cause ? ` (${cause})` : ""}`,
        0, cause, url, method, undefined,
        cause === "CERT_HAS_EXPIRED" || cause === "DEPTH_ZERO_SELF_SIGNED_CERT" || cause === "SELF_SIGNED_CERT_IN_CHAIN"
          ? "TLS certificate was rejected. For a staging box set allowInsecureTLS: true on the site config."
          : "Check the site URL is reachable from this machine and that the host is not blocking outside requests."
      );
    } finally {
      clearTimeout(timer);
    }

    let data: any = null;
    const contentType = res.headers.get("content-type") ?? "";
    if (text) data = parseBody(text, contentType);

    if (!res.ok) {
      const code = typeof data === "object" && data ? data.code : undefined;
      const message =
        (typeof data === "object" && data && (data.message ?? data.error)) ||
        (typeof data === "string" && data.trim().slice(0, 400)) ||
        res.statusText ||
        "Unknown error";
      let hint = hintForFailure(res.status, code);
      if (typeof data === "string" && /<html/i.test(data)) {
        hint = "The site returned HTML rather than JSON — usually a security plugin, a WAF challenge page, or a wrong REST prefix.";
      }
      const failure = new WPError(stripTags(String(message)), res.status, code, url, method, data, hint);
      failure.retryAfter = res.headers.get("retry-after");
      throw failure;
    }

    // Every REST route returns JSON. An HTML body on a 2xx means something in
    // front of WordPress answered instead — a WAF challenge, a caching layer, or
    // a login wall. Content-Type is deliberately not consulted: those pages
    // legitimately declare text/html, which is exactly the case to catch.
    if (typeof data === "string" && /^\s*<(!doctype|html)\b/i.test(data.trimStart())) {
      throw new WPError(
        "The site returned HTML where JSON was expected.",
        res.status, "html_response", url, method, data.slice(0, 400),
        "This is almost always a security plugin or WAF serving a challenge page, or a caching layer returning the wrong document. Allowlist this client, or check the REST prefix."
      );
    }

    if (typeof data === "string" && contentType.includes("json")) {
      throw new WPError(
        "The site declared JSON but sent a body that does not parse as JSON.",
        res.status, "invalid_json", url, method, data.slice(0, 400),
        "Usually PHP output leaking into the response — a warning printed with display_errors on, or stray whitespace from a plugin file. Turn off display_errors (WP_DEBUG_DISPLAY false) and check the PHP error log."
      );
    }

    const total = res.headers.get("x-wp-total");
    const totalPages = res.headers.get("x-wp-totalpages");
    return {
      data: data as T,
      status: res.status,
      headers: res.headers,
      total: total ? Number(total) : undefined,
      totalPages: totalPages ? Number(totalPages) : undefined,
    };
  }

  get<T = any>(route: string, query?: Record<string, unknown>) {
    return this.request<T>(route, { method: "GET", query });
  }
  post<T = any>(route: string, body?: unknown, query?: Record<string, unknown>) {
    return this.request<T>(route, { method: "POST", body, query });
  }
  del<T = any>(route: string, query?: Record<string, unknown>) {
    return this.request<T>(route, { method: "DELETE", query });
  }

  /** Walks pagination until `limit` items are gathered (or the pages run out). */
  async getAll<T = any>(route: string, query: Record<string, unknown> = {}, limit = 300): Promise<T[]> {
    const perPage = Math.min(100, limit);
    const out: T[] = [];
    let page = 1;
    while (out.length < limit) {
      const res = await this.get<T[]>(route, { ...query, per_page: perPage, page });
      const batch = Array.isArray(res.data) ? res.data : [];
      out.push(...batch);
      if (batch.length < perPage) break;
      if (res.totalPages && page >= res.totalPages) break;
      page += 1;
      if (page > 100) break;
    }
    return out.slice(0, limit);
  }

  /** Registered post types, cached for the process lifetime (60s). */
  async postTypes(force = false): Promise<Record<string, any>> {
    if (!force && this.typeCache && Date.now() - this.typeCache.at < 60_000) return this.typeCache.data;
    const res = await this.get<Record<string, any>>("/wp/v2/types");
    this.typeCache = { at: Date.now(), data: res.data };
    return res.data;
  }

  async taxonomies(force = false): Promise<Record<string, any>> {
    if (!force && this.taxonomyCache && Date.now() - this.taxonomyCache.at < 60_000) return this.taxonomyCache.data;
    const res = await this.get<Record<string, any>>("/wp/v2/taxonomies");
    this.taxonomyCache = { at: Date.now(), data: res.data };
    return res.data;
  }

  /** Resolves a post type slug (post, page, docs...) to its REST base (posts, pages, docs...). */
  async restBaseForType(type: string): Promise<string> {
    const types = await this.postTypes();
    if (types[type]?.rest_base) return types[type].rest_base;
    // Allow callers to pass the rest_base directly.
    const byBase = Object.values(types).find((t: any) => t.rest_base === type);
    if (byBase) return (byBase as any).rest_base;
    const known = Object.keys(types).join(", ");
    throw new Error(
      `Unknown content type "${type}". Types registered on ${this.site.id}: ${known}. Run discover_content_types for the full picture — a type missing here is usually registered with show_in_rest => false.`
    );
  }

  async restBaseForTaxonomy(taxonomy: string): Promise<string> {
    const taxes = await this.taxonomies();
    if (taxes[taxonomy]?.rest_base) return taxes[taxonomy].rest_base;
    const byBase = Object.values(taxes).find((t: any) => t.rest_base === taxonomy);
    if (byBase) return (byBase as any).rest_base;
    throw new Error(
      `Unknown taxonomy "${taxonomy}". Registered: ${Object.keys(taxes).join(", ")}. Run discover_taxonomies — a taxonomy missing here is usually registered with show_in_rest => false.`
    );
  }

  /** The site's registered namespaces + routes; used to detect optional features. */
  async discovery(force = false) {
    if (!force && this.routeCache && Date.now() - this.routeCache.at < 60_000) return this.routeCache;
    const res = await this.get<any>("/");
    const namespaces: string[] = res.data?.namespaces ?? [];
    const routes: string[] = Object.keys(res.data?.routes ?? {});
    this.routeCache = { at: Date.now(), namespaces, routes };
    return this.routeCache;
  }

  /**
   * Whether the companion plugin's namespace is registered. Only a missing index
   * means "no"; an unreachable site or rejected credentials is rethrown, so the
   * caller reports the real failure instead of telling someone to install a
   * plugin they already have.
   */
  async hasHelperPlugin(): Promise<boolean> {
    try {
      const d = await this.discovery();
      return d.namespaces.includes(this.site.helperNamespace ?? "wpxmcp/v1");
    } catch (error) {
      if (error instanceof WPError && error.status === 404) return false;
      throw error;
    }
  }
}

/** Basename + safe characters, without depending on node:path. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "upload.bin";
}

function extname(name: string): string {
  const base = sanitizeFilename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
  ".pdf": "application/pdf", ".zip": "application/zip", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm",
  ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

export function guessMimeType(filename: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[extname(filename)] ?? fallback;
}

/**
 * Reads a file from the machine running this server. Only meaningful for the
 * local stdio server — a remote Worker has no access to the caller's disk.
 */
export function readLocalFile(filePath: string): { data: Uint8Array; filename: string; contentType: string } {
  const runtime = platform();
  if (!runtime.readLocalFile) {
    throw new Error(
      `This server is running remotely (${runtime.kind}), so it cannot read "${filePath}" from your machine — there is no shared filesystem. Upload the file with \`url\` (a publicly reachable URL) or \`base64_data\` instead. Running wpxmcp locally over stdio does support file_path.`
    );
  }
  return runtime.readLocalFile(filePath);
}
