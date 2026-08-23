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

const USER_AGENT = "wpxmcp/1.0 (+https://github.com/wpxmcp/wpxmcp)";

/** UTF-8 safe base64 encode that works on both Node and Workers. */
function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
    const clean = route.startsWith("/") ? route : `/${route}`;
    const prefix = this.site.restPrefix ?? "/wp-json";
    let url: URL;
    if (prefix.includes("rest_route")) {
      url = new URL(this.site.url + "/");
      url.searchParams.set("rest_route", clean);
    } else {
      url = new URL(this.site.url + prefix.replace(/\/+$/, "") + clean);
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

  async request<T = any>(route: string, options: RequestOptions = {}): Promise<WPResponse<T>> {
    const method = options.method ?? "GET";
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

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "follow",
        // @ts-expect-error undici-specific option, honoured by Node's global fetch
        dispatcher: await this.dispatcher(),
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
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

    const text = await res.text();
    let data: any = null;
    const contentType = res.headers.get("content-type") ?? "";
    if (text) {
      if (contentType.includes("json")) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      } else {
        data = text;
      }
    }

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
      throw new WPError(stripTags(String(message)), res.status, code, url, method, data, hint);
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

  async hasHelperPlugin(): Promise<boolean> {
    try {
      const d = await this.discovery();
      return d.namespaces.includes(this.site.helperNamespace ?? "wpxmcp/v1");
    } catch {
      return false;
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
