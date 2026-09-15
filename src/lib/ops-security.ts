/**
 * Pure helpers behind the webmaster "ops" tools: version matching against
 * WPVulnerability ranges, response signatures for exposed files, header
 * analysis, scoring, and turning the companion plugin's /security facts into
 * findings. No I/O here, so every rule is unit-testable and runs on Workers.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
  fix: string;
  tool_to_fix?: string;
}

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const SEVERITY_PENALTY: Record<Severity, number> = { critical: 25, high: 12, medium: 6, low: 2, info: 0 };

/* ------------------------------------------------------------------ *
 * Versions
 * ------------------------------------------------------------------ */

/**
 * Compares WordPress-style version strings ("6.4.1", "1.0.0-beta2", "5.3").
 * Missing segments count as 0; a pre-release suffix sorts before the release.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = String(v ?? "").trim().replace(/^v/i, "");
    const m = /^([0-9][0-9.]*)(.*)$/.exec(s);
    const nums = (m ? m[1] : "0").split(".").filter((x) => x !== "").map((x) => Number(x) || 0);
    const pre = m ? m[2].replace(/^[-_.+]/, "").toLowerCase() : s.toLowerCase();
    return { nums, pre };
  };
  const x = split(a);
  const y = split(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface VulnOperator {
  min_version?: string | null;
  min_operator?: string | null;
  max_version?: string | null;
  max_operator?: string | null;
  unfixed?: string | number | boolean | null;
}

function applyOp(cmp: number, op: string | null | undefined): boolean {
  switch (String(op ?? "").toLowerCase()) {
    case "lt": return cmp < 0;
    case "le": case "lte": return cmp <= 0;
    case "gt": return cmp > 0;
    case "ge": case "gte": return cmp >= 0;
    case "eq": return cmp === 0;
    default: return true;
  }
}

/** Whether `version` falls inside a WPVulnerability affected range. */
export function isAffected(version: string, op: VulnOperator | null | undefined): boolean {
  if (!op) return true;
  if (!version) return true;
  if (op.min_version && op.min_operator && !applyOp(compareVersions(version, op.min_version), op.min_operator)) return false;
  if (op.max_version && op.max_operator && !applyOp(compareVersions(version, op.max_version), op.max_operator)) return false;
  return true;
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Severity of one WPVulnerability entry from its CVSS data. */
export function vulnSeverity(v: any): Severity {
  const impact = v?.impact;
  const word = String(impact?.cvss3?.severity ?? impact?.cvss4?.severity ?? "").toLowerCase();
  if (word === "critical" || word === "high" || word === "medium" || word === "low") return word;
  const letter = String(impact?.cvss?.severity ?? "").toLowerCase();
  const byLetter: Record<string, Severity> = { c: "critical", h: "high", m: "medium", l: "low", n: "info" };
  if (byLetter[letter]) return byLetter[letter];
  const score = Number(impact?.cvss3?.score ?? impact?.cvss?.score);
  if (Number.isFinite(score)) return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
  // No CVSS published: assume it matters until proven otherwise.
  return "medium";
}

export function worstSeverity(list: Severity[]): Severity {
  for (const s of SEVERITY_ORDER) if (list.includes(s)) return s;
  return "info";
}

export interface ComponentVulns {
  affected: Array<{ name: string; severity: Severity; ids: string[]; fixed_in: string | null; unfixed: boolean }>;
  worst: Severity;
  fixed_in: string | null;
  unfixed: boolean;
}

/**
 * Filters a WPVulnerability response down to the entries affecting the
 * installed version. Core responses are already per-version (no operator);
 * plugin and theme responses carry an affected range per entry.
 */
export function affectingVulns(data: any, version: string): ComponentVulns {
  const list: any[] = Array.isArray(data?.vulnerability) ? data.vulnerability : [];
  const affected: ComponentVulns["affected"] = [];
  let fixedIn: string | null = null;
  let unfixed = false;
  for (const v of list) {
    if (v?.operator && !isAffected(version, v.operator)) continue;
    const op: VulnOperator = v?.operator ?? {};
    const noFix = isTruthyFlag(op.unfixed);
    const fix = !noFix && op.max_version && /^(lt|le|lte)$/i.test(String(op.max_operator ?? "")) ? String(op.max_version) : null;
    // "le X" means X itself is vulnerable, so the fix is whatever comes after.
    const fixLabel = fix && /^le/i.test(String(op.max_operator)) ? `> ${fix}` : fix;
    if (noFix) unfixed = true;
    if (fix && (!fixedIn || compareVersions(fix, fixedIn.replace(/^> /, "")) > 0)) fixedIn = fixLabel;
    const ids = (Array.isArray(v?.source) ? v.source : [])
      .map((s: any) => String(s?.id ?? ""))
      .filter((id: string) => /^CVE-/i.test(id))
      .slice(0, 3);
    affected.push({ name: String(v?.name ?? "unnamed").slice(0, 160), severity: vulnSeverity(v), ids, fixed_in: fixLabel, unfixed: noFix });
  }
  return { affected, worst: worstSeverity(affected.map((a) => a.severity)), fixed_in: fixedIn, unfixed };
}

/** Plugins whose WordPress.org slug differs from their install directory. */
export function wpOrgSlug(kind: "plugin" | "theme", slug: string): string {
  if (kind === "plugin" && slug === "hello") return "hello-dolly";
  return slug;
}

/* ------------------------------------------------------------------ *
 * PHP lifecycle
 * ------------------------------------------------------------------ */

/** End of security support for each PHP branch (php.net/supported-versions). */
export const PHP_EOL: Record<string, string> = {
  "5.6": "2018-12-31", "7.0": "2019-01-10", "7.1": "2019-12-01", "7.2": "2020-11-30",
  "7.3": "2021-12-06", "7.4": "2022-11-28", "8.0": "2023-11-26", "8.1": "2025-12-31",
  "8.2": "2026-12-31", "8.3": "2027-12-31", "8.4": "2028-12-31", "8.5": "2029-12-31",
};

export function phpSupportStatus(version: string, now: Date = new Date()): { branch: string; eol_date: string | null; eol: boolean; months_left: number | null } {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ""));
  const branch = m ? `${m[1]}.${m[2]}` : String(version ?? "");
  let eolDate = PHP_EOL[branch] ?? null;
  // Branches older than the table are long dead.
  if (!eolDate && m && compareVersions(branch, "5.6") < 0) eolDate = "2018-12-31";
  if (!eolDate) return { branch, eol_date: null, eol: false, months_left: null };
  const end = Date.parse(`${eolDate}T23:59:59Z`);
  const months = Math.round(((end - now.getTime()) / (30.44 * 24 * 3600 * 1000)) * 10) / 10;
  return { branch, eol_date: eolDate, eol: end < now.getTime(), months_left: months };
}

/* ------------------------------------------------------------------ *
 * Response signatures
 * ------------------------------------------------------------------ */

const HTML_START = /^\s*(?:<!doctype|<html|<head|<body)/i;

export function looksLikeHtml(body: string): boolean {
  return HTML_START.test(body);
}

export function looksLikePhpLog(body: string): boolean {
  if (looksLikeHtml(body)) return false;
  return /^\[\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}[^\]]*\]\s/m.test(body) || /\bPHP (?:Fatal error|Warning|Notice|Deprecated|Parse error):/.test(body);
}

export function looksLikeWpConfig(body: string): boolean {
  if (looksLikeHtml(body)) return false;
  return /DB_(?:PASSWORD|NAME|USER|HOST)|\$table_prefix|AUTH_KEY/.test(body);
}

export function looksLikeVimSwap(body: string): boolean {
  return body.startsWith("b0VIM");
}

export function looksLikeGitHead(body: string): boolean {
  return /^(?:ref: refs\/|[0-9a-f]{40}\s*$)/.test(body.trim());
}

export function looksLikeEnvFile(body: string): boolean {
  if (looksLikeHtml(body)) return false;
  const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return false;
  const assignments = lines.filter((l) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/.test(l)).length;
  return assignments >= 1 && assignments / lines.length >= 0.6;
}

export function looksLikeDirectoryListing(body: string): boolean {
  return /<title>\s*Index of \//i.test(body) || /<h1>\s*Index of \//i.test(body) || /Directory listing for \//i.test(body);
}

/** WordPress version from a generator meta tag, if the page leaks it. */
export function generatorVersion(html: string): string | null {
  const m = /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([0-9][0-9a-z.\-]*)["']/i.exec(html)
    ?? /<meta[^>]+content=["']WordPress\s+([0-9][0-9a-z.\-]*)["'][^>]+name=["']generator["']/i.exec(html);
  return m ? m[1] : null;
}

/** A short, redacted excerpt suitable for evidence — never real file contents. */
export function redactExcerpt(body: string, max = 120): string {
  return String(body ?? "")
    .slice(0, Math.min(max, 200))
    .replace(/(['"]?(?:DB_[A-Z]+|PASSWORD|SECRET|KEY|TOKEN|SALT)[A-Z_]*['"]?\s*[,=:]\s*)(['"]?)[^'"\s,)]+/gi, "$1$2[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\/[\w.-]+){2,}/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

type HeaderBag = { get(name: string): string | null };

export function headerBag(h: HeaderBag | Record<string, string>): HeaderBag {
  if (typeof (h as HeaderBag).get === "function") return h as HeaderBag;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, string>)) lower[k.toLowerCase()] = v;
  return { get: (n: string) => lower[n.toLowerCase()] ?? null };
}

export function securityHeaderFindings(raw: HeaderBag | Record<string, string>, https: boolean, local: boolean): Finding[] {
  const h = headerBag(raw);
  const out: Finding[] = [];
  const csp = h.get("content-security-policy") ?? "";
  if (https && !h.get("strict-transport-security")) {
    out.push({
      id: "header_hsts_missing", severity: "low", title: "No Strict-Transport-Security header",
      evidence: "The HTTPS homepage response carries no HSTS header, so a first visit over http:// can be intercepted.",
      fix: "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` from the web server or CDN once HTTPS works everywhere.",
    });
  }
  if (!/nosniff/i.test(h.get("x-content-type-options") ?? "")) {
    out.push({
      id: "header_nosniff_missing", severity: "low", title: "No X-Content-Type-Options: nosniff",
      evidence: "Homepage response lacks `X-Content-Type-Options: nosniff`.",
      fix: "Add `X-Content-Type-Options: nosniff` at the web server, or send it from a snippet hooked to `send_headers`.",
      tool_to_fix: "code_snippet",
    });
  }
  if (!h.get("x-frame-options") && !/frame-ancestors/i.test(csp)) {
    out.push({
      id: "header_framing_unrestricted", severity: "low", title: "Pages can be framed by any site (clickjacking)",
      evidence: "Neither X-Frame-Options nor a CSP frame-ancestors directive is present on the homepage.",
      fix: "Send `X-Frame-Options: SAMEORIGIN` or `Content-Security-Policy: frame-ancestors 'self'`. WordPress already sends it for wp-admin and the login page.",
      tool_to_fix: "code_snippet",
    });
  }
  if (!h.get("referrer-policy")) {
    out.push({
      id: "header_referrer_policy_missing", severity: "info", title: "No Referrer-Policy header",
      evidence: "Homepage response has no Referrer-Policy; browsers default to strict-origin-when-cross-origin, which is acceptable.",
      fix: "Optionally send `Referrer-Policy: strict-origin-when-cross-origin` explicitly.",
    });
  }
  if (local) for (const f of out) f.severity = "info";
  return out;
}

/** Cache-related response headers and what they suggest about freshness. */
export function cacheHeaderSummary(raw: HeaderBag | Record<string, string>): { headers: Record<string, string>; verdict: "hit" | "miss" | "bypass" | "unknown"; hint: string } {
  const h = headerBag(raw);
  const names = [
    "cache-control", "age", "x-cache", "x-cache-status", "cf-cache-status", "x-litespeed-cache", "x-wp-rocket",
    "x-rocket-nginx-serving-static", "x-proxy-cache", "x-sg-cache", "x-kinsta-cache", "x-varnish", "x-fastcgi-cache",
    "x-nginx-cache", "x-cacheable", "x-wpe-cached", "x-served-by", "x-powered-by-cache", "x-hcdn-cache-status", "wpo-cache-status",
  ];
  const headers: Record<string, string> = {};
  for (const n of names) {
    const v = h.get(n);
    if (v !== null && v !== "") headers[n] = v.slice(0, 200);
  }
  const blob = Object.entries(headers)
    .filter(([k]) => k !== "cache-control" && k !== "x-served-by")
    .map(([, v]) => v.toLowerCase())
    .join(" ");
  let verdict: "hit" | "miss" | "bypass" | "unknown" = "unknown";
  if (/\bhit\b|\bcached\b|\bstale\b/.test(blob)) verdict = "hit";
  else if (/\bmiss\b|\bexpired\b|\bmiss,/.test(blob)) verdict = "miss";
  else if (/bypass|dynamic|no-cache|pass/.test(blob)) verdict = "bypass";
  const age = Number(headers.age);
  if (verdict === "unknown" && Number.isFinite(age) && age > 0) verdict = "hit";
  const hint = verdict === "hit"
    ? `A cache served this response${Number.isFinite(age) ? ` (age ${age}s)` : ""}. Right after a purge that usually means a CDN or proxy WordPress cannot reach still holds the old copy — purge it at its own dashboard, or fetch again to see whether it refreshes.`
    : verdict === "miss"
      ? "The response was a cache MISS, so it was generated fresh — the purge took effect for this URL."
      : verdict === "bypass"
        ? "The cache was bypassed for this request (often because it carries cookies or query strings); a logged-out visitor may still see a cached copy."
        : "No recognisable cache headers — either there is no page cache, or it does not announce itself.";
  return { headers, verdict, hint };
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id));
}

/**
 * 100 minus a weighted penalty per finding. Criticals cap the grade: a site
 * serving its database password is an F no matter how tidy its headers are.
 */
export function scoreFindings(findings: Finding[]): { score: number; grade: "A" | "B" | "C" | "D" | "F" } {
  let score = 100;
  for (const f of findings) score -= SEVERITY_PENALTY[f.severity] ?? 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const criticals = findings.filter((f) => f.severity === "critical").length;
  const highs = findings.filter((f) => f.severity === "high").length;
  if (criticals) score = Math.min(score, 49);
  else if (highs) score = Math.min(score, 79);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  return { score, grade };
}

/* ------------------------------------------------------------------ *
 * Inside checks (companion plugin facts → findings)
 * ------------------------------------------------------------------ */

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) || h.endsWith(".local") || h.endsWith(".test") || h.endsWith(".localhost")
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

const DAY = 24 * 3600 * 1000;

export function insideFindings(sec: any, opts: { now?: Date; local?: boolean; debugLogPublic?: boolean | null } = {}): Finding[] {
  const now = opts.now ?? new Date();
  const out: Finding[] = [];
  const push = (f: Finding) => out.push(f);
  const debug = sec?.debug ?? {};
  const hard = sec?.hardening ?? {};

  if (debug.WP_DEBUG && debug.WP_DEBUG_DISPLAY) {
    push({
      id: "debug_display_on", severity: opts.local ? "info" : "high", title: "PHP errors are printed to visitors",
      evidence: "WP_DEBUG is on and WP_DEBUG_DISPLAY is on (it defaults to true when not defined).",
      fix: "In wp-config.php add define( 'WP_DEBUG_DISPLAY', false ); and @ini_set( 'display_errors', 0 ); — keep WP_DEBUG_LOG for diagnosis.",
    });
  } else if (!debug.WP_DEBUG && debug.display_errors) {
    push({
      id: "display_errors_on", severity: opts.local ? "info" : "medium", title: "PHP display_errors is on",
      evidence: "php.ini display_errors is enabled, so warnings can leak file paths into pages even with WP_DEBUG off.",
      fix: "Set display_errors = Off in php.ini (or the host's PHP settings), or add @ini_set( 'display_errors', 0 ); to wp-config.php.",
    });
  }
  if (debug.debug_log_in_webroot) {
    const exposed = opts.debugLogPublic === true;
    if (!exposed) {
      push({
        id: "debug_log_in_webroot", severity: opts.debugLogPublic === false ? "low" : "medium",
        title: "debug.log is written inside wp-content",
        evidence: `WP_DEBUG_LOG is true, so errors go to wp-content/debug.log${opts.debugLogPublic === false ? " (the external probe could not download it, so the server blocks it today)" : ""}.`,
        fix: "Point WP_DEBUG_LOG at a path outside the web root, e.g. define( 'WP_DEBUG_LOG', '/home/user/logs/wp-debug.log' );",
        tool_to_fix: "tail_error_log",
      });
    }
  }
  if (hard.DISALLOW_FILE_EDIT === false && hard.DISALLOW_FILE_MODS !== true) {
    push({
      id: "file_editor_enabled", severity: "medium", title: "The wp-admin theme/plugin file editor is enabled",
      evidence: "DISALLOW_FILE_EDIT is not set, so any stolen administrator session can write PHP straight into the site.",
      fix: "Add define( 'DISALLOW_FILE_EDIT', true ); to wp-config.php.",
    });
  }
  if (hard.default_salts) {
    push({
      id: "default_salts", severity: "high", title: "Security keys and salts are missing or left at their defaults",
      evidence: "At least one of AUTH_KEY…NONCE_SALT is undefined, empty or 'put your unique phrase here'.",
      fix: "Replace the eight keys in wp-config.php with fresh values from https://api.wordpress.org/secret-key/1.1/salt/ (this logs everyone out).",
    });
  }
  if (hard.xmlrpc_enabled) {
    push({
      id: "xmlrpc_enabled_filter", severity: "info", title: "XML-RPC authentication is enabled",
      evidence: "apply_filters( 'xmlrpc_enabled', true ) is true. See the xmlrpc external check for whether xmlrpc.php answers.",
      fix: "If nothing uses XML-RPC (Jetpack and the mobile apps can), add a snippet: add_filter( 'xmlrpc_enabled', '__return_false' ); and block xmlrpc.php at the server.",
      tool_to_fix: "code_snippet",
    });
  }
  if (hard.table_prefix === "wp_") {
    push({
      id: "table_prefix_default", severity: "info", title: "Default database table prefix wp_",
      evidence: "Table prefix is wp_. This only slows down automated SQL-injection payloads marginally.",
      fix: "Not worth changing on an existing site; use a random prefix on new installs.",
    });
  }
  if (hard.users_can_register && hard.default_role && !["subscriber", "customer"].includes(String(hard.default_role))) {
    push({
      id: "open_registration_privileged_role", severity: "critical", title: `Anyone can register and receives the "${hard.default_role}" role`,
      evidence: `users_can_register is on and default_role is ${hard.default_role}.`,
      fix: "Set default_role back to subscriber, or turn off registration, in Settings → General.",
      tool_to_fix: "update_site_settings",
    });
  }

  const cfg = sec?.wp_config ?? {};
  if (cfg.found && !cfg.windows) {
    if (cfg.world_writable) {
      push({
        id: "wp_config_world_writable", severity: "critical", title: "wp-config.php is world-writable",
        evidence: `File mode ${cfg.mode}: any account on the server can rewrite it.`,
        fix: "chmod 640 wp-config.php (or 600 where PHP runs as the file owner).",
      });
    } else if (cfg.world_readable) {
      push({
        id: "wp_config_world_readable", severity: "low", title: "wp-config.php is world-readable",
        evidence: `File mode ${cfg.mode}: on shared hosting another account could read the database password.`,
        fix: "chmod 640 wp-config.php (or 600 where PHP runs as the file owner) — confirm the site still loads afterwards.",
      });
    }
  }

  const ssl = sec?.ssl ?? {};
  if (ssl.home_scheme === "http") {
    push({
      id: "no_https", severity: opts.local ? "info" : "high", title: "The site URL is http://, not https://",
      evidence: `home and siteurl use ${ssl.home_scheme}/${ssl.siteurl_scheme}; logins and cookies travel unencrypted.`,
      fix: "Install a TLS certificate (most hosts offer free Let's Encrypt), then switch both URLs to https:// in Settings → General and redirect http to https at the server.",
      tool_to_fix: "update_site_settings",
    });
  }

  const admins = sec?.admins ?? {};
  const list: any[] = Array.isArray(admins.list) ? admins.list : [];
  const weak = list.filter((a) => a.weak_name).map((a) => a.login);
  if (weak.length) {
    push({
      id: "admin_guessable_username", severity: opts.local ? "low" : "medium", title: "Administrator with a guessable username",
      evidence: `Administrator login(s): ${weak.join(", ")}. Brute-force tools try these first.`,
      fix: "Create a new administrator with a non-obvious username, log in as it, then delete the old account and attribute its content to the new one.",
      tool_to_fix: "create_user",
    });
  }
  if (list.length > 3) {
    push({
      id: "many_admins", severity: "low", title: `${list.length} administrator accounts`,
      evidence: `Administrators: ${list.slice(0, 10).map((a) => a.login).join(", ")}${list.length > 10 ? ", …" : ""}.`,
      fix: "Downgrade anyone who does not need full control to Editor.",
      tool_to_fix: "update_user",
    });
  }
  const stale: string[] = [];
  for (const a of list) {
    for (const p of Array.isArray(a.app_password_list) ? a.app_password_list : []) {
      const last = p.last_used ? Date.parse(p.last_used) : NaN;
      const created = p.created ? Date.parse(p.created) : NaN;
      const unusedFor = Number.isFinite(last) ? now.getTime() - last : Number.isFinite(created) ? now.getTime() - created : 0;
      if (unusedFor > 90 * DAY) stale.push(`${a.login}: "${p.name}" (${Number.isFinite(last) ? `last used ${p.last_used.slice(0, 10)}` : "never used"})`);
    }
  }
  if (stale.length) {
    push({
      id: "stale_application_passwords", severity: "low", title: "Application passwords unused for 90+ days",
      evidence: stale.slice(0, 10).join("; "),
      fix: "Revoke application passwords nobody uses (Users → Profile → Application Passwords). Each one is a standing credential with the admin's full rights.",
    });
  }
  if (admins.application_passwords_total) {
    push({
      id: "application_passwords_present", severity: "info", title: `${admins.application_passwords_total} application password(s) on administrator accounts`,
      evidence: list.filter((a) => a.application_passwords).map((a) => `${a.login}: ${a.application_passwords}${a.app_password_last_used ? ` (last used ${String(a.app_password_last_used).slice(0, 10)})` : ""}`).join("; "),
      fix: "Keep one per integration and revoke any you do not recognise.",
    });
  }

  const wp = sec?.wordpress ?? {};
  if (wp.update_available && wp.latest && wp.version) {
    const sameBranch = String(wp.version).split(".").slice(0, 2).join(".") === String(wp.latest).split(".").slice(0, 2).join(".");
    push({
      id: "core_outdated", severity: sameBranch ? "high" : "medium", title: `WordPress ${wp.version} is behind ${wp.latest}`,
      evidence: sameBranch ? "A minor (security/maintenance) release for this branch is available and not applied." : "A newer major version is available.",
      fix: "Take a backup (backup_status), then update WordPress core from Dashboard → Updates.",
      tool_to_fix: "backup_status",
    });
  }
  const php = sec?.php?.version ? phpSupportStatus(sec.php.version, now) : null;
  if (php?.eol_date) {
    if (php.eol) {
      const old = compareVersions(php.branch, "8.0") < 0;
      push({
        id: "php_eol", severity: old ? "high" : "medium", title: `PHP ${sec.php.version} no longer receives security fixes`,
        evidence: `PHP ${php.branch} reached end of life on ${php.eol_date}.`,
        fix: "Switch to PHP 8.3 or newer in the hosting control panel after checking plugin compatibility on staging.",
      });
    } else if (php.months_left !== null && php.months_left < 6) {
      push({
        id: "php_eol_soon", severity: "low", title: `PHP ${php.branch} reaches end of life on ${php.eol_date}`,
        evidence: `About ${php.months_left} months of security support left.`,
        fix: "Plan the move to PHP 8.3+ now.",
      });
    }
  }

  const plugins = sec?.plugins ?? {};
  const pluginUpdates: any[] = Array.isArray(plugins.updates) ? plugins.updates : [];
  if (pluginUpdates.length) {
    push({
      id: "plugin_updates", severity: "high", title: `${pluginUpdates.length} plugin update(s) pending`,
      evidence: pluginUpdates.slice(0, 15).map((u) => `${u.file} ${u.current ?? "?"} → ${u.new ?? "?"}`).join("; "),
      fix: "Back up, then update — outdated plugins are the most common way WordPress sites are compromised. run_wp_cli \"plugin update <slug>\".",
      tool_to_fix: "run_wp_cli",
    });
  }
  const themeUpdates: any[] = Array.isArray(sec?.themes?.updates) ? sec.themes.updates : [];
  if (themeUpdates.length) {
    push({
      id: "theme_updates", severity: "medium", title: `${themeUpdates.length} theme update(s) pending`,
      evidence: themeUpdates.slice(0, 10).map((u) => `${u.slug} ${u.current ?? "?"} → ${u.new ?? "?"}`).join("; "),
      fix: "Update the themes (a child theme keeps customisations safe). run_wp_cli \"theme update <slug>\".",
      tool_to_fix: "run_wp_cli",
    });
  }
  if (plugins.inactive > 0) {
    const names = (Array.isArray(plugins.installed) ? plugins.installed : []).filter((p: any) => !p.active).map((p: any) => p.slug);
    push({
      id: "inactive_plugins", severity: "low", title: `${plugins.inactive} inactive plugin(s) installed`,
      evidence: `Inactive code is still reachable by direct request and still needs updates: ${names.slice(0, 15).join(", ")}.`,
      fix: "Delete plugins you are not using.",
      tool_to_fix: "delete_plugin",
    });
  }
  const themes = sec?.themes ?? {};
  if (themes.inactive > 1) {
    push({
      id: "inactive_themes", severity: "low", title: `${themes.inactive} inactive theme(s) installed`,
      evidence: (Array.isArray(themes.installed) ? themes.installed : []).filter((t: any) => !t.active).map((t: any) => t.slug).slice(0, 15).join(", "),
      fix: "Keep one default theme as a fallback and delete the rest.",
      tool_to_fix: "run_wp_cli",
    });
  }
  const auto = sec?.auto_updates ?? {};
  if (auto.AUTOMATIC_UPDATER_DISABLED) {
    push({
      id: "auto_updates_disabled", severity: "medium", title: "All automatic updates are disabled",
      evidence: "AUTOMATIC_UPDATER_DISABLED is true, so even core security releases are not applied automatically.",
      fix: "Remove AUTOMATIC_UPDATER_DISABLED from wp-config.php, or make sure someone applies updates weekly.",
    });
  } else if (plugins.total > 0 && plugins.auto_update_enabled === 0) {
    push({
      id: "plugin_auto_updates_off", severity: "info", title: "No plugin has auto-updates enabled",
      evidence: `0 of ${plugins.total} plugins auto-update.`,
      fix: "Enable auto-updates for low-risk plugins from the Plugins screen, or schedule regular manual updates.",
    });
  }
  return out;
}
