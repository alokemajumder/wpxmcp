/**
 * Pure helpers for growth.ts: link extraction, link graphs, robots.txt,
 * calendar maths, CSV and bounded concurrency. No I/O, Workers-safe.
 */
import { decodeHtml } from "./growth-seo.js";

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. Never rejects. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ *
 * Links
 * ------------------------------------------------------------------ */

export interface ExtractedLink { url: string; kind: "a" | "img" }

/**
 * Pulls <a href> and <img src> targets out of HTML, resolved against `base`,
 * fragments dropped, de-duplicated. Non-web schemes (mailto:, tel:, data:,
 * javascript:) and pure fragments are skipped.
 */
export function extractLinks(html: string, base: string, opts: { images?: boolean } = {}): ExtractedLink[] {
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  const add = (raw: string | undefined, kind: "a" | "img") => {
    const value = decodeHtml(String(raw ?? "")).trim();
    if (!value || value.startsWith("#")) return;
    if (/^(mailto|tel|sms|data|javascript|about|blob|ftp|file):/i.test(value)) return;
    let url: URL;
    try { url = new URL(value, base); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const key = `${kind}|${url.toString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: url.toString(), kind });
  };
  const source = String(html ?? "").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of source.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3], "a");
  if (opts.images !== false) {
    for (const m of source.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3], "img");
  }
  return out;
}

/** Same host as the site (scheme may differ; www. is not folded — WordPress treats it as another host). */
export function isInternalUrl(siteUrl: string, candidate: string): boolean {
  try {
    const a = new URL(siteUrl);
    const b = new URL(candidate);
    const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    if (a.port || b.port) return port(a) === port(b);
    return true;
  } catch {
    return false;
  }
}

/** A stable key for matching a link to a piece of content: host-less path + id query args. */
export function contentKey(u: string): string {
  try {
    const url = new URL(u);
    for (const arg of ["p", "page_id", "attachment_id"]) {
      const v = url.searchParams.get(arg);
      if (v && /^\d+$/.test(v)) return `id:${v}`;
    }
    return `path:${decodeURIComponentSafe(url.pathname).replace(/\/+$/, "").toLowerCase() || "/"}`;
  } catch {
    return `raw:${u}`;
  }
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The last path segment — the slug WordPress would look up — or null. */
export function slugFromUrl(u: string): string | null {
  try {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponentSafe(last).toLowerCase() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Link graph
 * ------------------------------------------------------------------ */

export interface GraphItem {
  id: number;
  type: string;
  status: string;
  title: string;
  link: string;
  slug?: string;
  html: string;
  terms: number[];
}

export interface GraphResult {
  inbound: Map<number, Set<number>>;
  outbound: Map<number, Set<number>>;
  /** Internal links that point at a known item that is not published. */
  toUnpublished: Array<{ from: number; url: string; target: number; target_status: string }>;
  /** Internal links that resolve to nothing scanned (archives, missing content, or outside the scan). */
  unresolved: Array<{ from: number; url: string }>;
}

export function buildLinkGraph(siteUrl: string, items: GraphItem[], others: Array<{ id: number; status: string; link?: string; slug?: string }> = []): GraphResult {
  const byKey = new Map<string, { id: number; status: string }>();
  const bySlug = new Map<string, { id: number; status: string }>();
  const register = (x: { id: number; status: string; link?: string; slug?: string }) => {
    byKey.set(`id:${x.id}`, x);
    if (x.link) byKey.set(contentKey(x.link), x);
    if (x.slug) bySlug.set(String(x.slug).toLowerCase(), x);
  };
  for (const o of others) register(o);
  for (const it of items) register(it); // scanned items win over the lightweight list

  const inbound = new Map<number, Set<number>>();
  const outbound = new Map<number, Set<number>>();
  for (const it of items) { inbound.set(it.id, new Set()); outbound.set(it.id, new Set()); }
  const toUnpublished: GraphResult["toUnpublished"] = [];
  const unresolved: GraphResult["unresolved"] = [];

  for (const it of items) {
    for (const link of extractLinks(it.html, it.link || siteUrl, { images: false })) {
      if (!isInternalUrl(siteUrl, link.url)) continue;
      const key = contentKey(link.url);
      if (key === "path:/" || /\/wp-(content|admin|includes|json)\//.test(link.url)) continue;
      let target = byKey.get(key);
      if (!target && key.startsWith("path:")) {
        const slug = slugFromUrl(link.url);
        if (slug) target = bySlug.get(slug);
      }
      if (!target) { unresolved.push({ from: it.id, url: link.url }); continue; }
      if (target.id === it.id) continue;
      if (target.status !== "publish") toUnpublished.push({ from: it.id, url: link.url, target: target.id, target_status: target.status });
      outbound.get(it.id)!.add(target.id);
      inbound.get(target.id)?.add(it.id);
    }
  }
  return { inbound, outbound, toUnpublished, unresolved };
}

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i in into is it its of on or our so that the their this to was what when where which who why will with you your "
    + "we us my me can do does not no yes all any more most new get got just about after before over under up out one two vs via").split(" ")
);

/** Meaningful lower-case title words (stopwords and very short words removed). */
export function keywords(text: string): string[] {
  return [...new Set(
    decodeHtml(String(text ?? "")).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  )];
}

export interface LinkSuggestion { from: number; to: number; score: number; shared_terms: number; shared_keywords: string[] }

/**
 * Pairs of items that look related (shared taxonomy terms and title keywords)
 * but have no link from `from` to `to`. Items with few inbound links are
 * preferred as targets, since that is where a new link helps most.
 */
export function suggestLinks(items: GraphItem[], graph: GraphResult, opts: { max?: number; minScore?: number; ignoreTerms?: number[] } = {}): LinkSuggestion[] {
  const max = opts.max ?? 30;
  const minScore = opts.minScore ?? 2;
  const ignore = new Set(opts.ignoreTerms ?? []);
  const kw = new Map(items.map((i) => [i.id, new Set(keywords(i.title))]));
  const terms = new Map(items.map((i) => [i.id, new Set(i.terms.filter((t) => !ignore.has(t)))]));
  const out: LinkSuggestion[] = [];
  for (const a of items) {
    if (a.status !== "publish") continue;
    for (const b of items) {
      if (a.id === b.id || b.status !== "publish") continue;
      if (graph.outbound.get(a.id)?.has(b.id)) continue;
      const sharedKw = [...kw.get(a.id)!].filter((w) => kw.get(b.id)!.has(w));
      const sharedTerms = [...terms.get(a.id)!].filter((t) => terms.get(b.id)!.has(t)).length;
      let score = sharedKw.length * 2 + sharedTerms;
      if (score < minScore || sharedKw.length + sharedTerms === 0) continue;
      const inbound = graph.inbound.get(b.id)?.size ?? 0;
      if (inbound === 0) score += 2;
      else if (inbound < 3) score += 1;
      out.push({ from: a.id, to: b.id, score, shared_terms: sharedTerms, shared_keywords: sharedKw });
    }
  }
  out.sort((x, y) => y.score - x.score || x.to - y.to || x.from - y.from);
  // Spread suggestions: at most three per source item.
  const perSource = new Map<number, number>();
  const picked: LinkSuggestion[] = [];
  for (const s of out) {
    const n = perSource.get(s.from) ?? 0;
    if (n >= 3) continue;
    perSource.set(s.from, n + 1);
    picked.push(s);
    if (picked.length >= max) break;
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * robots.txt
 * ------------------------------------------------------------------ */

export interface RobotsAnalysis { blocks_all: boolean; disallows_for_all: string[]; sitemaps: string[]; groups: number }

/** Parses robots.txt for the rules that matter in an audit: does `User-agent: *` block `/`, and which sitemaps are declared. */
export function analyzeRobots(text: string): RobotsAnalysis {
  const sitemaps: string[] = [];
  const disallowAll: string[] = [];
  let allowRoot = false;
  let groups = 0;
  let agents: string[] = [];
  let inRules = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "sitemap") { if (value) sitemaps.push(value); continue; }
    if (field === "user-agent") {
      if (inRules) { agents = []; inRules = false; }
      if (!agents.length) groups++;
      agents.push(value.toLowerCase());
      continue;
    }
    if (field === "disallow" || field === "allow") {
      inRules = true;
      if (!agents.includes("*")) continue;
      if (field === "disallow" && value) disallowAll.push(value);
      if (field === "allow" && (value === "/" || value === "/*")) allowRoot = true;
    }
  }
  const blocksAll = !allowRoot && disallowAll.some((d) => d === "/" || d === "/*");
  return { blocks_all: blocksAll, disallows_for_all: disallowAll.slice(0, 30), sitemaps, groups };
}

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

/** Parses a WordPress date ("2026-09-15T10:00:00", site-local, no zone) as a naive UTC instant. */
export function parseWpDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO-8601 week key, e.g. "2026-W38". */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday (UTC date string) of the ISO week containing `date`. */
export function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

/** Consecutive ISO week keys from `offset` weeks relative to `now` (negative = past), `count` of them. */
export function weekSeries(now: Date, fromOffset: number, count: number): Array<{ week: string; starts: string }> {
  const out: Array<{ week: string; starts: string }> = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() + (fromOffset + i) * 7 * 86_400_000);
    out.push({ week: isoWeek(d), starts: weekStart(d) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CSV and cursors
 * ------------------------------------------------------------------ */

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection: a cell starting with = + - @ runs as a formula when opened.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");
}

/** Opaque, URL-safe cursor carrying a small JSON state. */
export function encodeCursor(state: Record<string, unknown>): string {
  return btoa(JSON.stringify(state)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor<T = Record<string, unknown>>(cursor: string | undefined | null): T | null {
  if (!cursor) return null;
  try {
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((cursor.length + 3) % 4);
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    throw new Error("That cursor is not valid. Pass the next_cursor value from a previous call unchanged, or omit it to start over.");
  }
}

/* ------------------------------------------------------------------ *
 * Fleet severity
 * ------------------------------------------------------------------ */

export type Severity = "critical" | "warning" | "info" | "ok";
const RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, ok: 0 };

export interface FleetIssue { severity: Severity; issue: string }

export function worstSeverity(issues: FleetIssue[]): Severity {
  return issues.reduce<Severity>((w, i) => (RANK[i.severity] > RANK[w] ? i.severity : w), "ok");
}

/** Sorts sites worst first: by severity, then number of critical+warning issues, then id. */
export function sortBySeverity<T extends { id: string; severity: Severity; issues: FleetIssue[] }>(rows: T[]): T[] {
  const weight = (r: T) => r.issues.reduce((n, i) => n + (i.severity === "critical" ? 100 : i.severity === "warning" ? 10 : i.severity === "info" ? 1 : 0), 0);
  return [...rows].sort((a, b) => RANK[b.severity] - RANK[a.severity] || weight(b) - weight(a) || a.id.localeCompare(b.id));
}
