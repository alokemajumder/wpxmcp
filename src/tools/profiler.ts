import { z } from "zod";
import { defineTool, ok, siteIdSchema, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import type { WordPressClient } from "../lib/client.js";
import { resolveSiteUrl, isSameSite } from "./site.js";
import { requireHelper } from "../lib/http-utils.js";

export const PROFILE_SECTIONS = ["template", "queries", "assets", "http", "hooks", "errors", "conditionals", "memory"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Everything except the "all hooks" counter, which slows the profiled request noticeably. */
export const DEFAULT_SECTIONS: ProfileSection[] = PROFILE_SECTIONS.filter((s) => s !== "hooks");

const MAX_REDIRECTS = 5;
/** The profiled body is only counted, never kept, but a runaway response must still end. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** How long to wait for the report after the page has been fetched. */
const RESULT_WAIT_MS = 3000;


/** Drains a body counting bytes, stopping at a cap. */
async function drainCounted(res: Response, maxBytes: number): Promise<{ bytes: number; truncated: boolean }> {
  if (!res.body) return { bytes: 0, truncated: false };
  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes, truncated: false };
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: maxBytes, truncated: true };
    }
  }
}

/** Removes the profiling token from a URL before it is shown to anyone. */
export function withoutToken(url: string | URL): string {
  const u = new URL(String(url));
  u.searchParams.delete("wpxmcp_profile");
  return u.toString();
}

export interface FetchTiming {
  status: number;
  final_status: number;
  final_url: string;
  content_type: string | null;
  ttfb_ms: number;
  total_ms: number;
  total_with_redirects_ms: number;
  bytes: number;
  body_truncated?: boolean;
  redirects: string[];
  redirect_not_followed?: string;
}

/**
 * Fetches the tokenised URL like an anonymous visitor would. The first hop is
 * the profiled request; same-site redirects are followed by hand (each hop
 * re-checked) only to report where the visitor lands.
 */
async function fetchProfiled(client: WordPressClient, start: URL): Promise<FetchTiming> {
  const timeoutMs = client.site.timeoutMs ?? 60_000;
  const headers = { "User-Agent": "wpxmcp/2.0 (profiler)", Accept: "text/html,*/*;q=0.8", ...(client.site.headers ?? {}) };
  const t0 = Date.now();
  let current = start;
  const redirects: string[] = [];
  let first: Pick<FetchTiming, "status" | "ttfb_ms" | "total_ms"> | undefined;
  try {
    for (let hop = 0; ; hop++) {
      const hopStart = Date.now();
      const res = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      const ttfb = Date.now() - hopStart;
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      const body = await drainCounted(res, MAX_BODY_BYTES);
      const hopTotal = Date.now() - hopStart;
      if (!first) first = { status: res.status, ttfb_ms: ttfb, total_ms: hopTotal };

      const done = (extra: Partial<FetchTiming> = {}): FetchTiming => ({
        ...first!,
        final_status: res.status,
        final_url: withoutToken(current),
        content_type: res.headers.get("content-type"),
        total_with_redirects_ms: Date.now() - t0,
        bytes: body.bytes,
        body_truncated: body.truncated || undefined,
        redirects,
        ...extra,
      });

      if (!location) return done();
      const next = new URL(location, current);
      if (!isSameSite(client.site.url, next) || hop >= MAX_REDIRECTS) return done({ redirect_not_followed: withoutToken(next) });
      redirects.push(withoutToken(next));
      current = next;
    }
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`Fetching ${withoutToken(current)} timed out after ${timeoutMs}ms.`);
    throw new Error(`Could not fetch ${withoutToken(current)}: ${e?.cause?.code ?? e?.message ?? String(e)}.`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the plugin for the stored report with a short backoff. */
async function collectReport(client: WordPressClient, ns: string, token: string): Promise<{ report?: any; state: string }> {
  const deadline = Date.now() + RESULT_WAIT_MS;
  let wait = 100;
  for (;;) {
    const res = await client.get<any>(`/${ns}/profile/result`, { token });
    if (res.data?.ready) return { report: res.data.report, state: "ready" };
    const state = String(res.data?.state ?? "none");
    if (Date.now() + wait > deadline) return { state };
    await sleep(wait);
    wait = Math.min(wait * 2, 800);
  }
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : ms < 10 ? `${Number(ms.toFixed(2))}ms` : `${Math.round(ms)}ms`);

/**
 * Plain-language findings a reader should look at first. Pure, so it is unit
 * tested against synthetic reports.
 */
export function profileFindings(report: any, opts: { slowQueryMs?: number; timing?: Partial<FetchTiming> } = {}): string[] {
  const out: string[] = [];
  const slowMs = opts.slowQueryMs ?? 5;
  const req = report?.request ?? {};
  const timing = opts.timing ?? {};

  if (req.fatal_error) out.push(`PHP fatal error in ${req.fatal_error.component}: ${req.fatal_error.message} (${req.fatal_error.file}:${req.fatal_error.line})`);
  if (typeof timing.status === "number" && timing.status >= 500) out.push(`The page returned HTTP ${timing.status}.`);
  if (timing.status === 404 || req.status === 404) out.push("The URL is a 404 — WordPress could not match it to content.");
  if (req.redirect_to) out.push(`The URL redirects (HTTP ${req.status}) to ${req.redirect_to}; the profile covers the redirecting request, not the destination. Profile the destination for its page cost.`);
  if (typeof req.server_ms === "number" && req.server_ms >= 1000) out.push(`Slow server response: PHP took ${fmtMs(req.server_ms)} to build the page.`);
  else if (typeof timing.ttfb_ms === "number" && timing.ttfb_ms >= 800) out.push(`Slow time to first byte: ${fmtMs(timing.ttfb_ms)}.`);

  const q = report?.queries;
  if (q) {
    if (q.count > 100) out.push(`${q.count} database queries on one page load (more than 100 usually means a loop querying per item).`);
    if (typeof q.total_ms === "number" && q.total_ms >= 200) out.push(`Database queries took ${fmtMs(q.total_ms)} in total.`);
    const dupes: any[] = q.duplicates ?? [];
    const extra = dupes.reduce((n, d) => n + (Number(d.count) - 1), 0);
    if (dupes.length) {
      const worst = dupes[0];
      const groups = q.duplicate_groups ?? dupes.length;
      out.push(`${groups} ${groups === 1 ? "query" : "distinct queries"} ran more than once (${extra} redundant executions); worst ran ${worst.count}× from ${(worst.callers ?? [])[0] ?? "unknown"}.`);
    }
    const slow = (q.slowest ?? []).filter((s: any) => typeof s.ms === "number" && s.ms >= slowMs);
    if (slow.length) out.push(`${slow.length} slow quer${slow.length === 1 ? "y" : "ies"} (≥ ${slowMs}ms); slowest ${fmtMs(slow[0].ms)} from ${slow[0].caller} [${slow[0].component}].`);
    const heavy = (q.by_component ?? []).filter((c: any) => c.component !== "core").sort((a: any, b: any) => b.count - a.count)[0];
    if (heavy && heavy.count >= 20) out.push(`${heavy.component} issues ${heavy.count} queries on this page.`);
    if (q.timed === false) out.push("Query timings unavailable: SAVEQUERIES is defined as false on this site, so queries were only counted.");
  }

  for (const call of report?.http?.calls ?? []) {
    if (typeof call.ms === "number" && call.ms >= 500) out.push(`Slow external HTTP call to ${call.url} took ${fmtMs(call.ms)} (${call.component}). It blocks page generation on every uncached view.`);
    else if (call.status === null && call.error) out.push(`External HTTP call to ${call.url} failed: ${call.error} (${call.component}).`);
  }
  const blockingCalls = (report?.http?.calls ?? []).filter((c: any) => c.blocking !== false);
  if (blockingCalls.length >= 3) out.push(`${blockingCalls.length} blocking outbound HTTP calls during a front-end request.`);

  const errs = report?.errors;
  const reportedItems = (errs?.items ?? []).filter((e: any) => !e.silenced);
  const reportedCount = errs?.reported_count ?? (errs?.items ? reportedItems.reduce((n: number, e: any) => n + (e.count ?? 1), 0) : errs?.count);
  if (reportedCount) {
    const levels = [...new Set(reportedItems.map((e: any) => e.level))].join("/");
    const top = reportedItems[0];
    out.push(`PHP ${levels || "errors"} on page: ${reportedCount}${top ? ` — e.g. "${String(top.message).slice(0, 120)}" in ${top.file}:${top.line} [${top.component}]` : ""}.`);
  }

  const tpl = report?.template;
  if (tpl) {
    if (tpl.from_child_theme) out.push(`Template file comes from the child theme: ${tpl.file}.`);
    if (tpl.block_template?.customized_in_database) out.push(`Block template "${tpl.block_template.slug}" has been customised in the Site Editor, so edits to the theme's file will not show.`);
    const parts = (tpl.template_parts ?? []).filter((p: any) => p.customized_in_database).map((p: any) => p.slug);
    if (parts.length) out.push(`Template part${parts.length > 1 ? "s" : ""} customised in the database (theme file edits will not show): ${parts.join(", ")}.`);
  }

  const assets = report?.assets;
  if (assets) {
    const scripts = assets.scripts?.count ?? 0;
    const styles = assets.styles?.count ?? 0;
    if (scripts + styles > 40) out.push(`${scripts} scripts and ${styles} stylesheets printed on this page.`);
    const blockingHead = (assets.scripts?.items ?? []).filter((s: any) => s.src && s.in_footer === false).length;
    if (blockingHead >= 10) out.push(`${blockingHead} scripts load in the <head> rather than the footer.`);
  }

  const mem = report?.memory;
  if (mem?.limit_bytes && mem.peak_bytes / mem.limit_bytes >= 0.75) out.push(`Peak memory ${(mem.peak_bytes / 1048576).toFixed(1)}MB is ${Math.round((mem.peak_bytes / mem.limit_bytes) * 100)}% of the PHP memory limit.`);
  if (mem?.object_cache && mem.object_cache.persistent === false && (report?.queries?.count ?? 0) > 50) out.push("No persistent object cache; a Redis/Memcached object cache would absorb many of these repeat queries.");

  return out;
}

/** Assets with inline-only handles collapsed to names, so the list shows what is actually downloaded. */
export function compactAssets(assets: any) {
  if (!assets) return undefined;
  const one = (group: any) => {
    const items: any[] = group?.items ?? [];
    const files = items.filter((i) => i.src).map(({ handle, src, ver, deps, in_footer, size_bytes, component }) => ({
      handle, src, ver, component, size_bytes, in_footer: in_footer ?? undefined, deps: deps?.length ? deps : undefined,
    }));
    const inline = items.filter((i) => !i.src).map((i) => i.handle);
    return { count: items.length, files: files.length, inline_only: inline.length, known_size_bytes: group?.known_size_bytes ?? 0, items: files, inline_handles: inline.length ? inline : undefined };
  };
  const byComponent: Record<string, number> = {};
  for (const i of [...(assets.scripts?.items ?? []), ...(assets.styles?.items ?? [])]) byComponent[i.component] = (byComponent[i.component] ?? 0) + 1;
  for (const i of assets.script_modules?.items ?? []) byComponent[i.component] = (byComponent[i.component] ?? 0) + 1;
  return { scripts: one(assets.scripts), script_modules: assets.script_modules ? one(assets.script_modules) : undefined, styles: one(assets.styles), by_component: byComponent };
}

/** Keeps the tool output focused: slow queries at the threshold, trimmed lists. */
export function shapeReport(url: string, timing: FetchTiming, report: any, slowQueryMs: number) {
  const q = report.queries;
  const queries = q ? {
    count: q.count,
    total_ms: q.total_ms,
    timed: q.timed,
    not_profiled_before_plugins_loaded: q.queries_before_profiler,
    slow_threshold_ms: slowQueryMs,
    slow: (q.slowest ?? []).filter((s: any) => q.timed === false || (typeof s.ms === "number" && s.ms >= slowQueryMs)).slice(0, 25),
    slowest_ms: q.slowest?.[0]?.ms ?? null,
    duplicates: q.duplicates ?? [],
    by_component: q.by_component,
  } : undefined;

  return {
    url,
    status: timing.status,
    final_status: timing.final_status !== timing.status ? timing.final_status : undefined,
    final_url: timing.redirects.length ? timing.final_url : undefined,
    redirects: timing.redirects.length ? timing.redirects : undefined,
    redirect_not_followed: timing.redirect_not_followed,
    timing: {
      ttfb_ms: timing.ttfb_ms,
      total_ms: timing.total_ms,
      server_ms: report.request?.server_ms ?? null,
      total_with_redirects_ms: timing.redirects.length ? timing.total_with_redirects_ms : undefined,
    },
    bytes: timing.bytes,
    content_type: timing.content_type,
    request: report.request,
    headline_findings: profileFindings(report, { slowQueryMs, timing }),
    template: report.template,
    conditionals: report.conditionals
      ? { true: report.conditionals.true, queried_object: report.conditionals.queried_object, request_vars: report.conditionals.request_vars, query_vars: report.conditionals.query_vars, found_posts: report.conditionals.found_posts, post_count: report.conditionals.post_count }
      : undefined,
    queries,
    assets: compactAssets(report.assets),
    http: report.http,
    hooks: report.hooks,
    errors: report.errors,
    memory: report.memory,
    truncated: report.truncated || undefined,
  };
}

export interface ProfileRun {
  url: string;
  timing: FetchTiming;
  report?: any;
  problem?: string;
}

export async function runProfile(
  client: WordPressClient,
  tool: string,
  opts: { url: string; sections: ProfileSection[]; asLoggedIn: boolean },
): Promise<ProfileRun> {
  const ns = await requireHelper(client, tool, "Profiling runs inside WordPress, so there is no core REST equivalent.");
  let target: URL;
  try {
    target = resolveSiteUrl(client.site.url, opts.url);
  } catch {
    throw new Error(`${tool} only profiles pages on the configured site (${new URL(client.site.url).origin}); "${opts.url}" points elsewhere. Pass a path such as "/about/".`);
  }
  target.searchParams.delete("wpxmcp_profile");
  const shown = target.toString();

  const issued = await client.post<any>(`/${ns}/profile/token`, {
    url: shown,
    sections: opts.sections,
    as_logged_in: opts.asLoggedIn,
  });
  const token = String(issued.data?.token ?? "");
  if (!/^[A-Za-z0-9]{32}$/.test(token)) throw new Error("The companion plugin did not return a profiling token. Update the wpxmcp helper plugin to a version with the profiler.");

  // The URL is built here, not taken from the plugin, so it is the exact same-site URL that was validated.
  const tokenised = new URL(shown);
  tokenised.searchParams.set("wpxmcp_profile", token);
  const timing = await fetchProfiled(client, tokenised);

  const { report, state } = await collectReport(client, ns, token);
  if (report?.error === "path_mismatch") return { url: shown, timing, problem: report.message };
  if (report?.error) return { url: shown, timing, problem: `The profiler failed inside WordPress: ${report.message ?? report.error}` };
  if (!report) {
    const problem = state === "unused"
      ? "The request never reached WordPress's PHP with the token: a page cache, CDN or security layer answered it (or stripped the query string). Exclude ?wpxmcp_profile= from caching, or purge the cache, then retry."
      : "The page was fetched but no report arrived in time. The PHP request may have died before shutdown (check the error log), or the result transient could not be stored.";
    return { url: shown, timing, problem };
  }
  return { url: shown, timing, report };
}

export function profilerTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "profile_url",
      title: "Profile a page (Query Monitor style)",
      readOnly: true,
      companion: "required",
      description:
        "Profile how WordPress builds one front-end URL, like Query Monitor but over MCP: which template renders it, every database query (count, total time, slowest with caller and plugin/theme attribution, duplicates), printed scripts/styles, outbound HTTP calls, PHP warnings/notices, conditional tags, memory and timing, plus headline findings. Uses a single-use token so only this one request is instrumented; ordinary visitors are unaffected. Profiles as an anonymous visitor by default. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        url: z.string().optional().default("/").describe("Path or full URL on the site, e.g. \"/about/\" or \"/?p=12\"."),
        sections: z.array(z.enum(PROFILE_SECTIONS)).optional()
          .describe("What to collect. Default: everything except \"hooks\" (counting every hook fired slows the request; ask for it explicitly)."),
        slow_query_ms: z.number().min(0).optional().default(5).describe("Queries at or above this many milliseconds are listed as slow."),
        as_logged_in: z.boolean().optional().default(false)
          .describe("Profile the page as the authenticated administrator (admin bar, logged-in queries) instead of as an anonymous visitor. The plugin switches the user for that request itself; no credentials are sent to the front end."),
      },
      handler: async ({ site_id, url, sections, slow_query_ms, as_logged_in }) => {
        const client = site(site_id);
        const run = await runProfile(client, "profile_url", {
          url, sections: sections?.length ? [...new Set(sections)] : DEFAULT_SECTIONS, asLoggedIn: as_logged_in,
        });
        if (!run.report) {
          return ok({ url: run.url, status: run.timing.status, timing: { ttfb_ms: run.timing.ttfb_ms, total_ms: run.timing.total_ms }, bytes: run.timing.bytes, profiled: false, problem: run.problem });
        }
        return ok(shapeReport(run.url, run.timing, run.report, slow_query_ms));
      },
    }),

    defineTool({
      name: "get_template_for_url",
      title: "Which template renders a URL",
      readOnly: true,
      companion: "required",
      description:
        "Answer \"which template file (or block template and template parts) renders this URL, and why?\" — the resolved file, the template hierarchy WordPress tried, whether a block template or part has been customised in the Site Editor, the queried object and the conditional tags that were true. A lightweight profile_url. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        url: z.string().optional().default("/").describe("Path or full URL on the site."),
        as_logged_in: z.boolean().optional().default(false).describe("Resolve as the logged-in administrator instead of an anonymous visitor."),
      },
      handler: async ({ site_id, url, as_logged_in }) => {
        const client = site(site_id);
        const run = await runProfile(client, "get_template_for_url", { url, sections: ["template", "conditionals"], asLoggedIn: as_logged_in });
        if (!run.report) return ok({ url: run.url, status: run.timing.status, resolved: false, problem: run.problem });
        const { template: t = {}, conditionals: c = {}, request: r = {} } = run.report;
        const notes: string[] = [];
        if (r.redirect_to) notes.push(`This URL redirects to ${r.redirect_to} before any template loads; ask about the destination instead.`);
        if (t.block_template?.customized_in_database) notes.push("The block template is customised in the database (Site Editor); edit it there or reset it, not in the theme file.");
        const customParts = (t.template_parts ?? []).filter((p: any) => p.customized_in_database).map((p: any) => p.slug);
        if (customParts.length) notes.push(`Customised template parts: ${customParts.join(", ")}.`);
        if (t.is_block_theme && t.file) notes.push("In a block theme the PHP file is always core's template-canvas.php; the block template below is what actually renders.");
        return ok({
          url: run.url,
          status: run.timing.status,
          theme: r.theme,
          parent_theme: r.parent_theme ?? undefined,
          is_block_theme: t.is_block_theme,
          file: t.file,
          file_component: t.file_component,
          from_child_theme: t.from_child_theme,
          block_template: t.block_template ?? undefined,
          template_parts: t.template_parts ?? undefined,
          hierarchy: t.hierarchy,
          queried_object: c.queried_object,
          conditionals_true: c.true,
          request_vars: c.request_vars,
          body_classes: t.body_classes,
          notes: notes.length ? notes : undefined,
        });
      },
    }),
  ];
}
