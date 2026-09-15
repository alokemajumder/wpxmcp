import { z } from "zod";
import { defineTool, ok, siteIdSchema, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import { audit } from "../lib/safety.js";
import { WPError } from "../lib/errors.js";
import type { WordPressClient } from "../lib/client.js";
import { resolveSiteUrl, isSameSite } from "./site.js";
import { readCapped, requireHelper } from "../lib/http-utils.js";
import {
  type Finding, type Severity,
  affectingVulns, cacheHeaderSummary, generatorVersion, insideFindings, isLocalHost, looksLikeDirectoryListing,
  looksLikeEnvFile, looksLikeGitHead, looksLikePhpLog, looksLikeVimSwap, looksLikeWpConfig,
  scoreFindings, securityHeaderFindings, sortFindings, SEVERITY_ORDER, wpOrgSlug,
} from "../lib/ops-security.js";

const USER_AGENT = "wpxmcp/2.0 (ops probe)";
const PROBE_TIMEOUT_MS = 10_000;
const VULN_API = "https://www.wpvulnerability.net";
const VULN_CONCURRENCY = 4;
const VULN_MAX_LOOKUPS = 60;


/** A missing route on an active plugin means the plugin is older than this server. */
async function helperCall<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WPError && error.status === 404 && error.code === "rest_no_route") {
      throw new Error(`"${tool}" needs a newer wpxmcp companion plugin: the installed copy is active but does not have this route yet. Update wp-plugin/wpxmcp-helper on the site from this repo.`);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Unauthenticated, bounded HTTP probes
 * ------------------------------------------------------------------ */

interface ProbeResult {
  url: string;
  status: number;
  headers: Headers | null;
  text: string;
  location: string | null;
  error?: string;
}


/**
 * Fetches a URL as an anonymous visitor would: no WordPress credentials, no
 * automatic redirects (a Location is reported, never followed off-site), a
 * hard timeout and a byte cap on the body.
 */
async function probe(client: WordPressClient, url: URL | string, init: { method?: string; body?: string; contentType?: string; maxBytes?: number; follow?: number } = {}): Promise<ProbeResult> {
  let current = new URL(String(url));
  const follow = init.follow ?? 0;
  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "*/*", ...(client.site.headers ?? {}) };
      if (init.contentType) headers["Content-Type"] = init.contentType;
      const res = await fetch(current.toString(), {
        method: init.method ?? "GET", headers, body: init.body, redirect: "manual", signal: controller.signal,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location && hop < follow) {
        const next = new URL(location, current);
        await res.body?.cancel().catch(() => undefined);
        if (isSameSite(client.site.url, next)) { current = next; continue; }
        return { url: current.toString(), status: res.status, headers: res.headers, text: "", location: next.toString() };
      }
      const text = location ? "" : (await readCapped(res, init.maxBytes ?? 4096)).text;
      if (location) await res.body?.cancel().catch(() => undefined);
      return { url: current.toString(), status: res.status, headers: res.headers, text, location };
    } catch (e: any) {
      const reason = e?.name === "AbortError" ? `timed out after ${PROBE_TIMEOUT_MS / 1000}s` : (e?.cause?.code ?? e?.message ?? String(e));
      return { url: current.toString(), status: 0, headers: null, text: "", location: null, error: String(reason) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ *
 * External checks
 * ------------------------------------------------------------------ */

interface ExternalOutcome {
  findings: Finding[];
  skipped: string[];
  ran: string[];
  homepageHtml: string;
  debugLogPublic: boolean | null;
}

const EXPOSED_FILES: Array<{ path: string; kind: "wpconfig" | "git" | "env" }> = [
  { path: "wp-config.php.bak", kind: "wpconfig" },
  { path: "wp-config.bak", kind: "wpconfig" },
  { path: "wp-config.php~", kind: "wpconfig" },
  { path: "wp-config.php.save", kind: "wpconfig" },
  { path: "wp-config.php.old", kind: "wpconfig" },
  { path: "wp-config.txt", kind: "wpconfig" },
  { path: ".wp-config.php.swp", kind: "wpconfig" },
  { path: ".git/HEAD", kind: "git" },
  { path: ".env", kind: "env" },
];

async function externalChecks(client: WordPressClient, local: boolean): Promise<ExternalOutcome> {
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const ran: string[] = [];
  const site = client.site.url;
  const at = (path: string) => resolveSiteUrl(site, path);
  let homepageHtml = "";
  let debugLogPublic: boolean | null = null;
  const unreachable = (name: string, r: ProbeResult): void => { skipped.push(`${name}: request failed (${r.error})`); };

  const tasks: Array<() => Promise<void>> = [
    // Homepage: security headers and generator leak.
    async () => {
      const r = await probe(client, at("/"), { maxBytes: 262144, follow: 3 });
      if (r.error || !r.headers) return unreachable("homepage headers", r);
      ran.push("security_headers", "generator_meta");
      homepageHtml = r.text;
      findings.push(...securityHeaderFindings(r.headers, new URL(r.url).protocol === "https:", local));
      const version = generatorVersion(r.text);
      if (version) {
        findings.push({
          id: "generator_version_leak", severity: "low", title: "WordPress version is advertised in the page source",
          evidence: `<meta name="generator" content="WordPress ${version}"> on the homepage.`,
          fix: "Add a snippet: remove_action( 'wp_head', 'wp_generator' ); — minor, but it tells scanners exactly which vulnerabilities to try.",
          tool_to_fix: "code_snippet",
        });
      }
    },
    // REST user enumeration, without credentials.
    async () => {
      const r = await probe(client, client.buildUrl("/wp/v2/users", { per_page: 10, _fields: "id,slug,name" }), { maxBytes: 32768 });
      if (r.error) return unreachable("rest_user_enumeration", r);
      ran.push("rest_user_enumeration");
      if (r.status !== 200) return;
      let users: any = null;
      try { users = JSON.parse(r.text); } catch { /* not JSON */ }
      if (Array.isArray(users) && users.length) {
        const slugs = users.map((u: any) => u?.slug).filter(Boolean).slice(0, 5);
        findings.push({
          id: "rest_user_enumeration", severity: local ? "low" : "medium", title: "Usernames can be listed without logging in",
          evidence: `An anonymous GET of /wp/v2/users returned ${users.length}${users.length === 10 ? "+" : ""} user(s); slugs: ${slugs.join(", ")}. Slugs usually equal the login name.`,
          fix: "Restrict the users endpoint to logged-in requests with a snippet (rest_endpoints filter unsetting /wp/v2/users for !is_user_logged_in()), or use a security plugin's option. Only authors with published posts are listed, so also avoid publishing as an administrator.",
          tool_to_fix: "code_snippet",
        });
      }
    },
    // ?author=N redirect leaks the login slug.
    async () => {
      const r = await probe(client, at("/?author=1"), { maxBytes: 65536 });
      if (r.error) return unreachable("author_enumeration", r);
      ran.push("author_enumeration");
      let slug: string | null = null;
      if (r.location) slug = /\/author\/([^/?#]+)/i.exec(r.location)?.[1] ?? null;
      else if (r.status === 200) slug = /<body[^>]+class=["'][^"']*\bauthor-(?!\d+\b)([a-z0-9_.-]+)/i.exec(r.text)?.[1] ?? null;
      if (slug) {
        findings.push({
          id: "author_enumeration", severity: "low", title: "?author=1 reveals a username",
          evidence: r.location ? `/?author=1 redirects to ${new URL(r.location, site).pathname}` : `/?author=1 renders the archive for "${slug}"`,
          fix: "Redirect ?author= queries for anonymous visitors (a snippet on template_redirect, or a security plugin setting).",
          tool_to_fix: "code_snippet",
        });
      }
    },
    // XML-RPC.
    async () => {
      const body = '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
      const r = await probe(client, at("/xmlrpc.php"), { method: "POST", body, contentType: "text/xml", maxBytes: 65536 });
      if (r.error) return unreachable("xmlrpc", r);
      ran.push("xmlrpc");
      if (r.status === 200 && /<methodResponse>/i.test(r.text)) {
        const multicall = /system\.multicall/.test(r.text);
        const pingback = /pingback\.ping/.test(r.text);
        findings.push({
          id: "xmlrpc_exposed", severity: local ? "low" : "medium", title: "xmlrpc.php answers anonymous requests",
          evidence: `system.listMethods succeeded${multicall ? "; system.multicall is available (hundreds of password guesses per request)" : ""}${pingback ? "; pingback.ping is available (DDoS reflection)" : ""}.`,
          fix: "If nothing needs XML-RPC (Jetpack and the WordPress mobile apps may), block xmlrpc.php at the web server or disable it with a snippet: add_filter( 'xmlrpc_enabled', '__return_false' ); plus removing pingback methods via xmlrpc_methods.",
          tool_to_fix: "code_snippet",
        });
      }
    },
    // Public debug.log.
    async () => {
      const r = await probe(client, at("/wp-content/debug.log"), { maxBytes: 4096 });
      if (r.error) return unreachable("public_debug_log", r);
      ran.push("public_debug_log");
      debugLogPublic = r.status === 200 && looksLikePhpLog(r.text);
      if (debugLogPublic) {
        findings.push({
          id: "debug_log_public", severity: "high", title: "wp-content/debug.log can be downloaded by anyone",
          evidence: `HTTP 200 with PHP log lines${r.headers?.get("content-length") ? ` (${r.headers.get("content-length")} bytes)` : ""}. Logs leak file paths, plugin names, SQL and sometimes personal data.`,
          fix: "Move the log outside the web root: define( 'WP_DEBUG_LOG', '/path/outside/webroot/debug.log' ); then delete wp-content/debug.log. Also deny *.log at the web server.",
          tool_to_fix: "tail_error_log",
        });
      }
    },
    // readme.html / license.txt.
    async () => {
      const [readme, license] = [await probe(client, at("/readme.html"), { maxBytes: 8192 }), await probe(client, at("/license.txt"), { maxBytes: 2048 })];
      if (readme.error) return unreachable("readme_license", readme);
      ran.push("readme_license");
      const exposed: string[] = [];
      if (readme.status === 200 && /wordpress/i.test(readme.text)) {
        const v = /Version\s+([0-9][0-9.]+)/i.exec(readme.text)?.[1];
        exposed.push(`readme.html${v ? ` (states version ${v})` : ""}`);
      }
      if (!license.error && license.status === 200 && /WordPress - Web publishing software/i.test(license.text)) exposed.push("license.txt");
      if (exposed.length) {
        findings.push({
          id: "readme_license_public", severity: "info", title: "Default WordPress readme/license files are public",
          evidence: `Reachable: ${exposed.join(", ")}. Confirms the site runs WordPress; recent versions no longer print the version in readme.html.`,
          fix: "Optional: block readme.html and license.txt at the web server (they are restored by every core update, so deleting them does not stick).",
        });
      }
    },
    // Backup / VCS / env files.
    async () => {
      const results = await pool(EXPOSED_FILES, 3, async (f) => ({ f, r: await probe(client, at(`/${f.path}`), { maxBytes: 4096 }) }));
      const failed = results.filter(({ r }) => r.error);
      if (failed.length === results.length) return unreachable("sensitive_file_exposure", failed[0].r);
      ran.push("sensitive_file_exposure");
      for (const { f, r } of results) {
        if (r.error || r.status !== 200 || !r.text) continue;
        if (f.kind === "wpconfig" && (looksLikeWpConfig(r.text) || looksLikeVimSwap(r.text))) {
          findings.push({
            id: `exposed_${f.path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}`, severity: "critical",
            title: `/${f.path} is publicly downloadable`,
            evidence: `HTTP 200 and the body looks like ${looksLikeVimSwap(r.text) ? "a vim swap file of wp-config.php" : "a copy of wp-config.php"} (database credentials and salts). Contents are not reproduced here.`,
            fix: `Delete /${f.path} from the server now, then change the database password and regenerate the salts — assume they have been read.`,
          });
        } else if (f.kind === "git" && looksLikeGitHead(r.text)) {
          findings.push({
            id: "exposed_git", severity: "high", title: "The .git directory is publicly accessible",
            evidence: "/.git/HEAD returns a git ref, so the full source history (and any committed secrets) can be reconstructed.",
            fix: "Deny access to /.git at the web server (or remove the directory from the web root) and rotate any secrets ever committed.",
          });
        } else if (f.kind === "env" && looksLikeEnvFile(r.text)) {
          const secrets = /(PASSWORD|SECRET|KEY|TOKEN|DB_)/i.test(r.text);
          const keys = [...r.text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]).slice(0, 6);
          findings.push({
            id: "exposed_env", severity: secrets ? "critical" : "high", title: "/.env is publicly downloadable",
            evidence: `HTTP 200 with KEY=value lines${secrets ? " including credential-like names" : ""}. Variable names seen (values withheld): ${keys.join(", ")}.`,
            fix: "Move .env outside the web root or deny dotfiles at the web server, then rotate every credential it contains.",
          });
        }
      }
    },
    // Directory listing on uploads.
    async () => {
      const r = await probe(client, at("/wp-content/uploads/"), { maxBytes: 16384 });
      if (r.error) return unreachable("uploads_directory_listing", r);
      ran.push("uploads_directory_listing");
      if (r.status === 200 && looksLikeDirectoryListing(r.text)) {
        findings.push({
          id: "uploads_directory_listing", severity: "medium", title: "Directory listing is enabled on /wp-content/uploads/",
          evidence: "The server returns an \"Index of\" page, exposing every uploaded file including unpublished ones.",
          fix: "Disable autoindex: `Options -Indexes` in .htaccess (Apache) or `autoindex off;` (nginx). An empty index.php in uploads also works.",
        });
      }
    },
    // http → https.
    async () => {
      const base = new URL(site);
      if (base.protocol !== "https:") {
        ran.push("https");
        findings.push({
          id: "no_https", severity: local ? "info" : "high", title: "The site is configured on http://, not https://",
          evidence: `Configured URL ${base.origin}. Logins and cookies travel unencrypted.`,
          fix: "Install a TLS certificate, switch the WordPress and site URLs to https:// in Settings → General, and redirect http to https at the server.",
          tool_to_fix: "update_site_settings",
        });
        return;
      }
      if (base.port) { skipped.push("http_to_https_redirect: the site uses a non-default port, so the plain-http address cannot be derived"); return; }
      const plain = new URL(base.toString());
      plain.protocol = "http:";
      const r = await probe(client, plain, { maxBytes: 1024 });
      if (r.error) { skipped.push(`http_to_https_redirect: port 80 did not answer (${r.error}) — fine if intentional`); return; }
      ran.push("http_to_https_redirect");
      const upgrades = r.location ? new URL(r.location, plain).protocol === "https:" : false;
      if (!upgrades) {
        findings.push({
          id: "http_not_redirected", severity: "medium", title: "http:// is not redirected to https://",
          evidence: `GET ${plain.origin}/ returned HTTP ${r.status}${r.location ? ` → ${r.location}` : ""}.`,
          fix: "Add a permanent (301) redirect from http to https at the web server or CDN.",
        });
      }
    },
  ];

  // The site may be a single-worker PHP server; a small pool avoids starving it.
  await pool(tasks, 3, (t) => t());
  return { findings, skipped, ran, homepageHtml, debugLogPublic };
}

/* ------------------------------------------------------------------ *
 * Vulnerability lookups
 * ------------------------------------------------------------------ */

interface Component { kind: "core" | "plugin" | "theme"; slug: string; name: string; version: string; active: boolean }

async function vulnerabilityFindings(components: Component[], max: number): Promise<{ findings: Finding[]; attempted: number; succeeded: number; failed: string[]; capped: number }> {
  const ordered = [
    ...components.filter((c) => c.kind === "core"),
    ...components.filter((c) => c.kind !== "core" && c.active),
    ...components.filter((c) => c.kind !== "core" && !c.active),
  ].filter((c) => c.slug && c.version);
  const selected = ordered.slice(0, max);
  const findings: Finding[] = [];
  const failed: string[] = [];
  let succeeded = 0;
  let consecutiveNetworkFailures = 0;
  let abandoned = false;

  await pool(selected, VULN_CONCURRENCY, async (c) => {
    if (abandoned) { failed.push(`${c.kind}:${c.slug} (skipped — API unreachable)`); return; }
    const path = c.kind === "core" ? `/core/${encodeURIComponent(c.version)}/` : `/${c.kind}/${encodeURIComponent(wpOrgSlug(c.kind, c.slug))}/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let data: any;
    try {
      const res = await fetch(VULN_API + path, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: controller.signal });
      if (!res.ok) { failed.push(`${c.kind}:${c.slug} (HTTP ${res.status})`); return; }
      const json: any = JSON.parse((await readCapped(res, 2 * 1024 * 1024)).text);
      data = json?.data;
      succeeded++;
      consecutiveNetworkFailures = 0;
    } catch (e: any) {
      failed.push(`${c.kind}:${c.slug} (${e?.name === "AbortError" ? "timeout" : e?.cause?.code ?? e?.message ?? "error"})`);
      if (++consecutiveNetworkFailures >= 4 && succeeded === 0) abandoned = true;
      return;
    } finally {
      clearTimeout(timer);
    }

    const v = affectingVulns(data, c.version);
    if (!v.affected.length) return;
    const label = c.kind === "core" ? `WordPress ${c.version}` : `${c.kind === "plugin" ? "Plugin" : "Theme"} ${c.name || c.slug} ${c.version}`;
    const sample = v.affected
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
      .slice(0, 5)
      .map((a) => `[${a.severity}] ${a.name}${a.ids.length ? ` (${a.ids.join(", ")})` : ""}`);
    const fix = c.kind === "core"
      ? "Update WordPress core to the latest release (back up first with backup_status)."
      : v.unfixed && !v.fixed_in
        ? `No fixed version is published. ${c.active ? "Deactivate and replace" : "Delete"} this ${c.kind}.`
        : c.active
          ? `Update to ${v.fixed_in ?? "the latest version"} or later: run_wp_cli "${c.kind} update ${c.slug}".`
          : `It is inactive — delete it (inactive code is still reachable), or update to ${v.fixed_in ?? "the latest version"}.`;
    findings.push({
      id: `vuln_${c.kind}_${c.slug}`,
      // Inactive plugin files remain directly requestable, but most exploits need the code loaded.
      severity: !c.active && c.kind !== "core" && v.worst === "critical" ? "high" : v.worst,
      title: `${label} has ${v.affected.length} known vulnerabilit${v.affected.length === 1 ? "y" : "ies"}${c.kind !== "core" && !c.active ? " (inactive)" : ""}`,
      evidence: sample.join("; ") + (v.affected.length > 5 ? `; …and ${v.affected.length - 5} more` : "") + ". Source: WPVulnerability.",
      fix,
      tool_to_fix: c.kind === "core" ? "backup_status" : !c.active ? (c.kind === "plugin" ? "delete_plugin" : "run_wp_cli") : "run_wp_cli",
    });
  });

  return { findings, attempted: selected.length, succeeded, failed, capped: Math.max(0, ordered.length - selected.length) };
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export function opsTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    defineTool({
      name: "tail_error_log",
      title: "Read the PHP error log",
      readOnly: true,
      description:
        "Read the end of the site's PHP error log (wp-content/debug.log or php.ini error_log) without downloading it, with duplicate errors grouped and each one attributed to the plugin, theme or core file that raised it. Also reports whether WP_DEBUG / WP_DEBUG_LOG / WP_DEBUG_DISPLAY are on and the last fatal error the companion plugin recorded — which is captured even when logging is off. Start here for white screens, 500 errors and \"there has been a critical error\". Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        lines: z.number().int().min(1).max(2000).optional().default(200).describe("How many lines to read from the end of the log (1–2000). Stack-trace lines count toward this."),
        level: z.enum(["fatal", "error", "warning", "notice", "deprecated", "all"]).optional().default("all")
          .describe("Minimum severity to include: \"warning\" returns fatals, errors and warnings; \"all\" also includes unrecognised lines."),
        since: z.string().optional().describe("Only entries at or after this time, as an ISO 8601 date/time, e.g. \"2026-09-15T08:00:00Z\"."),
        grep: z.string().max(200).optional().describe("Only entries whose message or stack trace contains this text (case-insensitive), e.g. a plugin slug."),
      },
      handler: async ({ site_id, lines, level, since, grep }) => {
        const client = site(site_id);
        if (since !== undefined && since !== "" && Number.isNaN(Date.parse(since))) {
          throw new Error(`\`since\` must be an ISO 8601 date/time such as "2026-09-15T08:00:00Z"; got "${since}".`);
        }
        const ns = await requireHelper(client, "tail_error_log");
        const res = await helperCall("tail_error_log", () => client.get<any>(`/${ns}/logs`, { lines, level, since, grep }));
        const data = res.data ?? {};
        const notes: string[] = [];
        if (data.last_fatal) notes.push(`Last recorded fatal (${data.last_fatal.time_gmt}${data.last_fatal.source ? `, from ${data.last_fatal.source}` : ""}): ${String(data.last_fatal.message).slice(0, 200)}`);
        if (data.groups?.length) notes.push(`${data.matched_entries} matching entries in ${data.distinct} distinct groups, newest first.`);
        return ok(data, notes.length ? notes.join("\n") : undefined);
      },
    }),

    defineTool({
      name: "purge_cache",
      title: "Purge site caches",
      idempotent: true,
      description:
        "Clear the site's caches through each installed cache layer's own API — WP Rocket, LiteSpeed, W3 Total Cache, WP Super Cache, WP Fastest Cache, SiteGround, Cache Enabler, Breeze, Hummingbird, Nginx Helper, Autoptimize, Varnish (Proxy Cache Purge), WP-Optimize, the Cloudflare plugin, and Kinsta / WP Engine / Pantheon / GoDaddy host caches — plus the object cache. Use it when a change does not appear on the front end. With scope \"url\" only that page is purged where the layer supports it. Afterwards the page is re-fetched as a visitor and its cache headers reported, so you can tell whether a CDN WordPress cannot reach still holds the old copy. Needs the companion plugin.",
      schema: {
        site_id: siteIdSchema,
        scope: z.enum(["all", "url"]).optional().default("all").describe("\"all\" purges every cache; \"url\" purges one page (layers without per-URL purging are cleared entirely)."),
        url: z.string().optional().describe("Path or full URL on this site to purge, e.g. \"/pricing/\". Required when scope is \"url\"; for \"all\" it only chooses which page to re-fetch for verification (default: homepage)."),
        verify: z.boolean().optional().default(true).describe("Re-fetch the page anonymously after purging and report its cache headers."),
      },
      handler: async ({ site_id, scope, url, verify }) => {
        const client = site(site_id);
        client.assertWritable("purge_cache");
        if (scope === "url" && !url) throw new Error("`url` is required when scope is \"url\" — pass the page's path, e.g. \"/about/\".");
        let target: URL;
        try {
          target = resolveSiteUrl(client.site.url, url ?? "/");
        } catch {
          throw new Error(`purge_cache only purges pages on the configured site (${new URL(client.site.url).origin}); "${url}" points elsewhere.`);
        }
        const ns = await requireHelper(client, "purge_cache");
        const res = await helperCall("purge_cache", () => client.post<any>(`/${ns}/cache/purge`, { scope, url: scope === "url" ? target.toString() : undefined }));
        const data = res.data ?? {};
        audit({ site: client.site.id, tool: "purge_cache", action: scope, target: scope === "url" ? target.toString() : "all", outcome: "ok", detail: `${(data.purged ?? []).join(", ")}${data.errors?.length ? ` | errors: ${data.errors.length}` : ""}`.slice(0, 300) });

        let verification: any;
        if (verify) {
          const r = await probe(client, target, { maxBytes: 1024, follow: 3 });
          verification = r.error || !r.headers
            ? { url: target.toString(), error: r.error ?? "no response" }
            : { url: r.url, status: r.status, ...cacheHeaderSummary(r.headers) };
        }
        return ok({ ...data, verification });
      },
    }),

    defineTool({
      name: "security_audit",
      title: "Audit site security",
      readOnly: true,
      description:
        "A read-only security review with a 0–100 score and prioritised findings, each with evidence and a concrete fix. Probes the site from outside as an anonymous visitor (user enumeration via REST and ?author=, XML-RPC, public debug.log, exposed wp-config backups / .git / .env, uploads directory listing, security headers, version leaks, http→https), inspects configuration from inside via the companion plugin (debug display, file editor, wp-config permissions, admin usernames, application passwords, salts, pending updates, PHP end-of-life, inactive plugins/themes, HTTPS), and checks core, plugin and theme versions against the free WPVulnerability database. Works partially without the companion plugin and says what it skipped. Never downloads more than a few KB of any exposed file.",
      schema: {
        site_id: siteIdSchema,
        include_vulnerabilities: z.boolean().optional().default(true).describe("Look up core, plugins and themes in the WPVulnerability database (outbound requests to wpvulnerability.net)."),
        max_lookups: z.number().int().min(1).max(VULN_MAX_LOOKUPS).optional().default(VULN_MAX_LOOKUPS).describe("Cap on vulnerability lookups; core first, then active plugins/themes, then inactive ones."),
        include_external: z.boolean().optional().default(true).describe("Run the anonymous outside-in probes against the site's own URL."),
      },
      handler: async ({ site_id, include_vulnerabilities, max_lookups, include_external }) => {
        const client = site(site_id);
        const checks_skipped: string[] = [];
        const checks_run: string[] = [];
        const findings: Finding[] = [];
        const host = new URL(client.site.url).hostname;
        let local = isLocalHost(host);

        let hasHelper = false;
        try {
          hasHelper = await client.hasHelperPlugin();
        } catch (e: any) {
          checks_skipped.push(`inside checks: the REST API could not be reached (${e?.message ?? e})`);
        }
        const ns = client.site.helperNamespace ?? "wpxmcp/v1";

        let sec: any = null;
        if (hasHelper) {
          try {
            sec = (await helperCall("security_audit", () => client.get<any>(`/${ns}/security`))).data;
            if (["local", "development"].includes(String(sec?.wordpress?.environment))) local = true;
          } catch (e: any) {
            checks_skipped.push(`inside checks: ${e?.message ?? e}`);
          }
        } else if (!checks_skipped.length) {
          checks_skipped.push("inside checks (debug display, file editor, wp-config permissions, admin usernames, application passwords, salts, updates, PHP version): the wpxmcp companion plugin is not active");
        }

        let external: ExternalOutcome | null = null;
        if (include_external) {
          external = await externalChecks(client, local);
          findings.push(...external.findings);
          checks_run.push(...external.ran.map((c) => `external:${c}`));
          checks_skipped.push(...external.skipped);
        } else {
          checks_skipped.push("external probes: include_external was false");
        }

        if (sec) {
          findings.push(...insideFindings(sec, { local, debugLogPublic: external ? external.debugLogPublic : null }));
          checks_run.push("inside:configuration");
        }

        let vulnerability_lookups: any;
        if (include_vulnerabilities) {
          const components: Component[] = [];
          if (sec) {
            components.push({ kind: "core", slug: "wordpress", name: "WordPress", version: String(sec.wordpress?.version ?? ""), active: true });
            for (const p of sec.plugins?.installed ?? []) components.push({ kind: "plugin", slug: p.slug, name: p.name, version: p.version, active: !!p.active });
            for (const t of sec.themes?.installed ?? []) components.push({ kind: "theme", slug: t.slug, name: t.name, version: t.version, active: !!t.active });
          } else {
            const coreVersion = external ? generatorVersion(external.homepageHtml) : null;
            if (coreVersion) components.push({ kind: "core", slug: "wordpress", name: "WordPress", version: coreVersion, active: true });
            else checks_skipped.push("core vulnerabilities: WordPress version unknown without the companion plugin");
            try {
              const plugins = await client.get<any[]>("/wp/v2/plugins", { context: "edit" });
              for (const p of plugins.data ?? []) {
                const file = String(p.plugin ?? "");
                const slug = file.includes("/") ? file.split("/")[0] : file.replace(/\.php$/, "");
                components.push({ kind: "plugin", slug, name: String(p.name ?? slug), version: String(p.version ?? ""), active: p.status !== "inactive" });
              }
            } catch (e: any) { checks_skipped.push(`plugin vulnerabilities: could not list plugins (${e?.message ?? e})`); }
            try {
              const themes = await client.get<any[]>("/wp/v2/themes", { context: "edit" });
              for (const t of themes.data ?? []) {
                components.push({ kind: "theme", slug: String(t.stylesheet ?? ""), name: String(t.name?.rendered ?? t.name?.raw ?? t.stylesheet ?? ""), version: String(t.version ?? ""), active: t.status === "active" });
              }
            } catch (e: any) { checks_skipped.push(`theme vulnerabilities: could not list themes (${e?.message ?? e})`); }
          }
          if (components.length) {
            const v = await vulnerabilityFindings(components, max_lookups);
            findings.push(...v.findings);
            checks_run.push("vulnerabilities:wpvulnerability.net");
            vulnerability_lookups = { attempted: v.attempted, succeeded: v.succeeded, failed: v.failed.length ? v.failed.slice(0, 20) : undefined, not_checked_due_to_cap: v.capped || undefined };
            if (v.failed.length) checks_skipped.push(`vulnerabilities: ${v.failed.length} of ${v.attempted} lookups failed (network or API) — those components were not checked`);
            if (v.capped) checks_skipped.push(`vulnerabilities: ${v.capped} component(s) beyond the ${max_lookups}-lookup cap were not checked`);
          }
        } else {
          checks_skipped.push("vulnerabilities: include_vulnerabilities was false");
        }

        // One finding per id; keep the most severe copy.
        const byId = new Map<string, Finding>();
        for (const f of findings) {
          const prev = byId.get(f.id);
          if (!prev || SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(prev.severity)) byId.set(f.id, f);
        }
        const sorted = sortFindings([...byId.values()]);
        const { score, grade } = scoreFindings(sorted);
        const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
        for (const f of sorted) counts[f.severity]++;

        return ok({
          site: client.site.id,
          url: client.site.url,
          score, grade, counts,
          environment: local ? "local/development — HTTPS and header findings are downgraded to info" : undefined,
          companion_plugin: hasHelper,
          findings: sorted,
          checks_run,
          checks_skipped,
          vulnerability_lookups,
        }, `Security score ${score}/100 (grade ${grade}): ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Nothing was changed.`);
      },
    }),

    defineTool({
      name: "backup_status",
      title: "Check backup status",
      readOnly: true,
      description:
        "Report which backup plugin the site uses (UpdraftPlus, BackWPup, Duplicator, All-in-One WP Migration, Jetpack VaultPress Backup, BlogVault, WPvivid, BackupBuddy) and when the last completed backup was taken, with a warning when there is none or it is stale. Run this before any risky change — updates, theme publishes, search-replace, bulk deletes. Host-level backups are invisible to WordPress and are flagged as unknown. Needs the companion plugin.",
      schema: { site_id: siteIdSchema },
      handler: async ({ site_id }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "backup_status");
        const res = await helperCall("backup_status", () => client.get<any>(`/${ns}/backups`));
        const d = res.data ?? {};
        return ok({
          detected: Array.isArray(d.detected) ? d.detected : [],
          latest_gmt: d.latest_gmt ?? null,
          age_hours: typeof d.age_hours === "number" ? d.age_hours : null,
          warning: d.warning ?? null,
        });
      },
    }),
  ];
}
