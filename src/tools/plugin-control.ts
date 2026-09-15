import { z } from "zod";
import { defineTool, ok, siteIdSchema, trimText, type ToolContext, type ToolSpec } from "../lib/tooling.js";
import { audit, issueConfirmation, consumeConfirmation, fingerprintOp } from "../lib/safety.js";
import type { WordPressClient } from "../lib/client.js";
import { protectedOptionReason } from "./power.js";
import { resolveSiteUrl, isSameSite } from "./site.js";
import { readCapped, requireHelper } from "../lib/http-utils.js";
import {
  parseAdminStructure, buildFormBody, stableFieldValues, closeMatches, VOLATILE_FIELDS, missingGroupOptions, looksIncomplete,
  type AdminForm, type AdminStructure,
} from "../lib/plugin-control-html.js";


/** Reduce any caller input (slug, full URL, "admin.php?page=x") to a wp-admin-relative string. */
function normalizeAdminPath(input: string): string {
  let s = String(input ?? "").trim();
  const marker = "wp-admin/";
  const at = s.lastIndexOf(marker);
  if (at !== -1) s = s.slice(at + marker.length);
  s = s.replace(/^\/+/, "");
  if (s === "") s = "index.php";
  return s;
}

/** A wp-admin link whose GET performs an action: it carries a nonce. */
export function isActionLink(relPath: string): boolean {
  const q = relPath.indexOf("?");
  if (q === -1) return false;
  for (const [k] of new URLSearchParams(relPath.slice(q + 1))) if (/^_?wpnonce$|nonce$/i.test(k)) return true;
  return false;
}

/** wp-admin screens that must never be submitted through this generic path. */
const FORBIDDEN_SUBMIT = [
  { re: /^plugins\.php/, why: "activating/deactivating/deleting plugins" },
  { re: /^plugin-install\.php/, why: "installing plugins" },
  { re: /^plugin-editor\.php/, why: "editing plugin files" },
  { re: /^theme-editor\.php/, why: "editing theme files" },
  { re: /^theme-install\.php/, why: "installing themes" },
  { re: /^users\.php.*action=delete/, why: "deleting users" },
  { re: /^user-new\.php/, why: "creating users" },
  { re: /^tools\.php.*page=export/, why: "exporting the site" },
  { re: /^update-core\.php/, why: "running core/plugin/theme updates" },
];

/** Where a settings form may post: options.php, admin-post.php, or a wp-admin screen. */
function actionAllowed(actionPath: string): boolean {
  return /^(options\.php|options-[\w-]+\.php|admin\.php|admin-post\.php|edit\.php|[\w-]+\.php)/.test(actionPath);
}

interface TokenisedResponse {
  status: number;
  location: string | null;
  html: string;
  contentType: string;
  finalUrl: string;
  authFailed: boolean;
}

/** Whether a redirect Location means WordPress rejected the request as unauthenticated. */
function isLoginRedirect(location: string | null): boolean {
  return !!location && /wp-login\.php|\/login(\/|\?|$)/.test(location);
}

/**
 * Perform exactly one tokenised wp-admin request: ask the plugin for a single-use
 * token bound to this path+method, then fetch/POST the wp-admin URL same-site with
 * that token. The plugin authenticates the request server-side; no cookie or
 * Application Password is sent to the front end, and redirects are never followed
 * automatically (a POST that became a GET would silently drop its body).
 */
async function tokenisedRequest(
  client: WordPressClient,
  ns: string,
  relPath: string,
  method: "GET" | "POST",
  body?: string,
  flow?: string
): Promise<TokenisedResponse> {
  const issued = await client.post<any>(`/${ns}/admin/token`, flow ? { path: relPath, method, flow } : { path: relPath, method });
  const token = String(issued.data?.token ?? "");
  if (!/^[A-Za-z0-9]{32}$/.test(token)) {
    throw new Error("The companion plugin did not return an admin token. Update the wpxmcp helper plugin to a version with the admin surface.");
  }

  const url = resolveSiteUrl(client.site.url, "/wp-admin/" + relPath);
  url.searchParams.set("wpxmcp_admin", token);
  if (!isSameSite(client.site.url, url)) {
    throw new Error(`Refusing to fetch ${url.toString()} — it is not on the configured site.`);
  }

  const timeoutMs = client.site.timeoutMs ?? 60_000;
  const headers: Record<string, string> = {
    "User-Agent": "wpxmcp/2.0 (admin)",
    Accept: "text/html,*/*;q=0.8",
    ...(client.site.headers ?? {}),
  };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === "POST" ? body : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  const contentType = res.headers.get("content-type") ?? "";
  // A redirect body is empty; only read HTML on a 2xx.
  let html = "";
  if ((res.status >= 200 && res.status < 300) || res.status >= 400) {
    html = (await readCapped(res, 5 * 1024 * 1024)).text;
  } else {
    await res.body?.cancel().catch(() => undefined);
  }

  const authFailed = isLoginRedirect(location) || /<form[^>]+name=["']loginform["']/i.test(html) || /id=["']loginform["']/i.test(html);
  return { status: res.status, location, html, contentType, finalUrl: url.toString(), authFailed };
}

/** GET a wp-admin screen, following at most a couple of same-site wp-admin redirects (each re-tokenised). */
async function fetchAdminPage(client: WordPressClient, ns: string, relPath: string, flow?: string): Promise<{ structure: AdminStructure; finalPath: string; res: TokenisedResponse }> {
  let path = relPath;
  for (let hop = 0; hop < 3; hop++) {
    const res = await tokenisedRequest(client, ns, path, "GET", undefined, flow);
    if (res.authFailed) {
      throw new Error(`Fetching /wp-admin/${path} was redirected to the login screen — the admin token was not accepted. Confirm the companion plugin is current and the REST caller is an administrator (super admin on multisite).`);
    }
    if (res.location && !isLoginRedirect(res.location)) {
      const next = new URL(res.location, res.finalUrl);
      if (isSameSite(client.site.url, next) && /wp-admin/.test(next.pathname)) {
        path = normalizeAdminPath(next.pathname + next.search);
        continue;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const message = res.html ? parseAdminStructure(res.html).text_summary.slice(0, 300) : "";
      throw new Error(`/wp-admin/${path} returned HTTP ${res.status}${message ? `: ${message}` : "."}${res.status === 403 ? " The screen may not exist (a plugin page that is not registered in the current state — e.g. before its setup wizard — reports 403), or it needs a capability the administrator lacks. Check list_admin_pages for the screens that exist." : ""}`);
    }
    return { structure: parseAdminStructure(res.html), finalPath: path, res };
  }
  throw new Error(`Too many redirects fetching /wp-admin/${relPath}.`);
}

/** A random flow id: the wp-admin requests of one operation share a session so the form's nonce validates. */
export function newFlowId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
}

/**
 * Preventive checks before a form may be posted. Returns a refusal reason, or
 * undefined when the form looks complete.
 */
async function completenessProblem(client: WordPressClient, ns: string, form: AdminForm, actionPath: string, flow: string): Promise<{ reason: string; would_wipe?: string[] } | undefined> {
  const optionPage = form.fields.find((f) => f.name === "option_page")?.value;
  const postsToOptions = actionPath.split("?")[0] === "options.php";
  if (postsToOptions || optionPage !== undefined) {
    // Load options.php (its "All Settings" view) so the plugin captures the exact allowlist it enforces.
    await tokenisedRequest(client, ns, "options.php", "GET", undefined, flow);
    const allowed = await client.get<any>(`/${ns}/admin/allowed-options`, { option_page: optionPage ?? "options" });
    if (!allowed.data?.captured) {
      return { reason: "Could not read the option group options.php enforces for this form, so it cannot be confirmed that submitting will not blank settings. Update the companion plugin, or retry." };
    }
    if (Array.isArray(allowed.data.options)) {
      const missing = missingGroupOptions(form, allowed.data.options, optionPage ?? "options");
      if (missing.length) {
        return {
          reason: `options.php saves every option in the "${optionPage}" group and sets any it is not sent to empty. This form, as parsed, has no field for: ${missing.join(", ")}. Submitting would wipe those settings — the form parse is most likely incomplete.`,
          would_wipe: missing,
        };
      }
    }
  }
  if (looksIncomplete(form)) {
    return { reason: `Only ${form.parsed_control_count} of the ${form.raw_control_count} named controls in this form's HTML were parsed, so the submission would be missing fields the screen may treat as cleared.` };
  }
  return undefined;
}

/** Resolve a form's action attribute to a wp-admin-relative path (empty action = the page itself). */
function resolveActionPath(client: WordPressClient, form: AdminForm, pagePath: string): { path: string; sameSite: boolean } {
  const action = (form.action ?? "").trim();
  if (action === "") return { path: normalizeAdminPath(pagePath), sameSite: true };
  let target: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(action) || action.startsWith("/")) {
      // Absolute URL or site-root-relative path.
      target = resolveSiteUrl(client.site.url, action);
    } else {
      // A bare action like "options.php" is relative to the current wp-admin page's directory.
      const base = resolveSiteUrl(client.site.url, "/wp-admin/" + normalizeAdminPath(pagePath));
      target = new URL(action, base);
      if (!isSameSite(client.site.url, target)) return { path: action, sameSite: false };
    }
  } catch {
    return { path: action, sameSite: false };
  }
  const sameSite = isSameSite(client.site.url, target) && /wp-admin\//.test(target.pathname);
  return { path: normalizeAdminPath(target.pathname + target.search), sameSite };
}

export function pluginControlTools(ctx: ToolContext): Array<ToolSpec<any>> {
  const { registry } = ctx;
  const site = (id?: string) => registry.resolve(id);

  return [
    /* -------------------------- inspect_plugin -------------------------- */
    defineTool({
      name: "inspect_plugin",
      title: "Inspect an installed plugin",
      readOnly: true,
      description:
        "Discover everything an installed plugin exposes and, crucially, how to control it: header data, whether it is active, version and pending update; its own REST routes (found by reflecting the callbacks defined in the plugin's files) with methods; Abilities API abilities it registers; Settings API settings it owns; the options it stores (with sizes and autoload); the wp-admin menu pages it adds; its custom post types, taxonomies, blocks, shortcodes and cron events. Returns a `control_surface` recommending the best path for changing its configuration — a REST route or ability where one exists, otherwise update_plugin_settings for its options, otherwise admin_page + submit_admin_form for its wp-admin screens. Use this first for any plugin (SEO plugins like Yoast or Rank Math, WooCommerce, forms, caching) before trying to change its settings.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier: its slug (\"wordpress-seo\"), its \"dir/file.php\" path, or its display name (\"Yoast SEO\")."),
      },
      handler: async ({ site_id, plugin }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "inspect_plugin");
        let res = await client.get<any>(`/${ns}/plugins/inspect`, { plugin });
        // Admin menus and admin_init-only settings are captured on a real wp-admin
        // request; take one when there is no current snapshot, then re-inspect.
        if (!res.data?.admin_snapshot?.captured) {
          try {
            await fetchAdminPage(client, ns, "index.php");
            res = await client.get<any>(`/${ns}/plugins/inspect`, { plugin });
          } catch { /* the snapshot refresh is best-effort */ }
        }
        return ok(res.data);
      },
    }),

    /* ------------------------ list_admin_pages ------------------------- */
    defineTool({
      name: "list_admin_pages",
      title: "List wp-admin menu pages",
      readOnly: true,
      description:
        "List the wp-admin menu and submenu pages registered on the site — title, slug, URL, parent, required capability and the plugin each belongs to — so you can find the screen for a task (e.g. Yoast's \"Search Appearance\", Rank Math's \"Titles & Meta\", WooCommerce's settings tabs). Pass `plugin` to list only that plugin's pages. Menus are built from a snapshot captured on a real admin request; this refreshes it if needed.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().optional().describe("Restrict to the pages added by this plugin (slug, dir/file, or name)."),
      },
      handler: async ({ site_id, plugin }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "list_admin_pages");
        let res = await client.get<any>(`/${ns}/admin/menu`, plugin ? { plugin } : undefined);
        if (!res.data?.captured || !res.data?.pages?.length) {
          await fetchAdminPage(client, ns, "index.php").catch(() => undefined);
          res = await client.get<any>(`/${ns}/admin/menu`, plugin ? { plugin } : undefined);
        }
        return ok(res.data);
      },
    }),

    /* -------------------------- admin_page ----------------------------- */
    defineTool({
      name: "admin_page",
      title: "View a wp-admin screen as admin",
      readOnly: true,
      description:
        "View any wp-admin screen as the authenticated administrator and get back its structure rather than raw HTML: the page title, its notices (errors, warnings, \"Settings saved\" messages), the wp-admin links on it, and every form with its fields (name, type, label, current value, options for selects/radios, whether required, and the help text), plus a capped text summary. This is how you read a plugin's settings screen that has no REST route — for example \"admin.php?page=wpseo_titles\" (Yoast) or \"admin.php?page=rank-math-options-titles\". The server authenticates the request with a single-use token; no cookie ever reaches the client.",
      schema: {
        site_id: siteIdSchema,
        url_or_page: z.string().describe("A wp-admin screen: \"admin.php?page=wpseo_titles\", \"options-general.php\", or a full wp-admin URL on this site."),
      },
      handler: async ({ site_id, url_or_page }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "admin_page");
        const relPath = normalizeAdminPath(url_or_page);
        if (isActionLink(relPath)) {
          return ok({ viewed: false, refused: true, reason: "That URL carries a nonce (_wpnonce), so loading it performs an action (activate, delete, trash…) rather than viewing a screen. admin_page only views screens; use the dedicated tool for the action." }, "Nothing was loaded.");
        }
        const { structure, finalPath } = await fetchAdminPage(client, ns, relPath);
        return ok({
          page: finalPath,
          title: structure.title,
          notices: structure.notices,
          links: structure.links.slice(0, 60),
          forms: structure.forms.map((f) => ({
            index: f.index,
            id: f.id,
            action: f.action || "(this page)",
            method: f.method,
            has_nonce: f.has_nonce,
            submit_buttons: f.submit_buttons,
            fields: f.fields.map((fld) => ({
              name: fld.name, type: fld.type, label: fld.label,
              value: fld.sensitive ? undefined : fld.value,
              checked: fld.checked,
              options: fld.options,
              required: fld.required, description: fld.description,
              sensitive: fld.sensitive || undefined, file: fld.file || undefined,
            })),
          })),
          text: trimText(structure.text_summary, 2000),
        });
      },
    }),

    /* ---------------------- get_plugin_settings ------------------------ */
    defineTool({
      name: "get_plugin_settings",
      title: "Read a plugin's settings option",
      readOnly: true,
      description:
        "Read an option a plugin owns, unserialised into JSON, with obvious secrets (keys matching pass/secret/token/api_key/license) redacted to \"••••\" plus the last four characters. Omit `option` to list the options the plugin appears to own so you can pick one. This reads the raw stored option — the same data the plugin's settings screen edits.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier (slug, dir/file, or name)."),
        option: z.string().optional().describe("The option name to read, e.g. \"wpseo_titles\". Omit to list the plugin's likely options."),
        reveal: z.boolean().optional().default(false).describe("Return secret values in the clear instead of redacting them. Use sparingly."),
      },
      handler: async ({ site_id, plugin, option, reveal }) => {
        const client = site(site_id);
        const ns = await requireHelper(client, "get_plugin_settings");
        const res = await client.get<any>(`/${ns}/plugins/settings`, { plugin, option, reveal });
        return ok(res.data);
      },
    }),

    /* --------------------- update_plugin_settings ---------------------- */
    defineTool({
      name: "update_plugin_settings",
      destructive: true,
      title: "Update a plugin's settings option",
      description:
        "Write an option a plugin owns through WordPress's update_option(), so any sanitize callback attached to it runs. Caveat: plugins that register settings only inside wp-admin (Yoast does) have no sanitizer in this request — the preview warns, and for those the plugin's settings screen via submit_admin_form is the sanitized path. Pass `changes` to deep-merge fields into the existing option (the usual case for a settings array), or `value` to replace the whole option. The previous value is backed up (last five kept) and can be undone with restore_plugin_settings. The first call is a dry run: it returns the before→after diff (before sanitization — the plugin may adjust or drop values on save) and a confirm_token; re-run with that token to apply, and the result reports what the sanitizer changed. Options wpxmcp protects, and options not attributable to the plugin (unless force_option), are refused. Prefer a plugin's REST route or ability when inspect_plugin shows one.",
      schema: {
        site_id: siteIdSchema,
        plugin: z.string().describe("Plugin identifier (slug, dir/file, or name)."),
        option: z.string().describe("The option name to write, e.g. \"wpseo_titles\"."),
        changes: z.record(z.string(), z.any()).optional().describe("Fields to deep-merge into the existing option value (for array/object options)."),
        value: z.any().optional().describe("A complete replacement value for the option. Use instead of `changes`, not with it."),
        force_option: z.boolean().optional().default(false).describe("Write even when the option is not attributable to this plugin. Off by default as a guard against typos."),
        confirm_token: z.string().optional().describe("Token from the dry-run preview, required to actually apply the write."),
      },
      handler: async ({ site_id, plugin, option, changes, value, force_option, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable("update_plugin_settings");
        const ns = await requireHelper(client, "update_plugin_settings");
        if (changes !== undefined && value !== undefined) {
          return ok({ updated: false, reason: "Pass either `changes` (deep-merge) or `value` (replace), not both." }, "Nothing was written.");
        }
        if (changes === undefined && value === undefined) {
          return ok({ updated: false, reason: "Pass `changes` (deep-merge) or `value` (replace)." }, "Nothing was written.");
        }

        const protectedReason = protectedOptionReason(option, value);
        if (protectedReason) {
          audit({ site: client.site.id, tool: "update_plugin_settings", action: "write", target: option, outcome: "refused", detail: protectedReason });
          return ok({ updated: false, refused: true, option, reason: protectedReason }, "Nothing was written.");
        }
        const current = await client.get<any>(`/${ns}/plugins/settings`, { plugin, option, reveal: false }).catch(() => null);
        const before = current?.data?.value;
        const owned = current?.data?.owned;
        // Settings a plugin registers only on admin_init have no sanitizer in a REST write.
        const inspected = await client.get<any>(`/${ns}/plugins/inspect`, { plugin }).catch(() => null);
        const registration = (inspected?.data?.registered_settings ?? []).find((r: any) => r.option_name === option);
        const adminOnly = registration?.registered_in === "wp-admin only";
        const sanitizerWarning = adminOnly
          ? `"${option}" is registered with the Settings API only inside wp-admin, so unless the plugin also attaches its own sanitize_option filter on every request, this write will not be sanitized (the result reports sanitize_filter_ran). The plugin's settings screen via submit_admin_form always saves through its real sanitizer.`
          : undefined;
        if (current?.data && current.data.owned === false && !force_option) {
          return ok({ updated: false, refused: true, option, reason: `"${option}" is not attributable to ${plugin} (it does not match the plugin's registered settings or option prefixes). Check the name with get_plugin_settings, or pass force_option: true if you are sure.` }, "Nothing was written.");
        }
        const fingerprint = fingerprintOp(["plugin_settings", client.site.id, option, JSON.stringify(before ?? null), JSON.stringify(changes ?? null), JSON.stringify(value ?? null), !!force_option]);

        if (!confirm_token) {
          const token = await issueConfirmation(client.site.id, `update_plugin_settings ${option}`, fingerprint);
          audit({ site: client.site.id, tool: "update_plugin_settings", action: "dry-run", target: option, outcome: "dry-run" });
          return ok({
            updated: false, dry_run: true, plugin, option,
            attributable_to_plugin: owned,
            sanitizer_warning: sanitizerWarning,
            before: before ?? null,
            proposed: value !== undefined ? { mode: "replace", value } : { mode: "deep-merge", changes },
            note_on_sanitization: "The plugin's sanitize callback may adjust or drop values when this is applied; the diff shown is before sanitization.",
            confirm_token: token,
          }, "This is a dry run — nothing was written. Review the change above, then re-run with this confirm_token to apply it. The token lasts 10 minutes and is bound to these exact arguments and the current option value.");
        }

        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) return ok({ updated: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing was written.");

        const body: Record<string, unknown> = { plugin, option, force_option };
        if (value !== undefined) body.value = value;
        else body.changes = changes;
        const res = await client.post<any>(`/${ns}/plugins/settings`, body);
        audit({ site: client.site.id, tool: "update_plugin_settings", action: "write", target: option, outcome: "ok" });

        const after = res.data?.value_after_sanitize;
        return ok({
          updated: true,
          plugin, option,
          changed: res.data?.changed,
          sanitize_filter_ran: res.data?.sanitize_filter_ran,
          sanitizer_adjusted: res.data?.sanitizer_adjusted,
          value_after_sanitize: after,
          undo: res.data?.undo,
        }, res.data?.sanitize_filter_ran === false
          ? "Written, but no sanitize callback was attached to this option in the REST request, so the value was stored as sent. If the plugin validates this setting on its wp-admin screen, re-save it there (submit_admin_form) or undo with restore_plugin_settings."
          : res.data?.sanitizer_adjusted?.length
            ? "Written. The plugin's sanitizer changed or dropped the fields listed in sanitizer_adjusted."
            : "Written and read back.");
      },
    }),

    /* --------------------- restore_plugin_settings --------------------- */
    defineTool({
      name: "restore_plugin_settings",
      destructive: true,
      title: "Restore a plugin option from backup",
      description:
        "Restore an option to a value saved before an update_plugin_settings write. Every write keeps the last five previous values; by default this restores the most recent. The first call previews the current value next to the one that would be restored and returns a confirm_token; the second applies it. The current value is itself backed up first, so a restore is undoable. Use this to roll back a settings change that broke something.",
      schema: {
        site_id: siteIdSchema,
        option: z.string().describe("The option name to restore."),
        backup_index: z.number().int().min(0).optional().describe("Which backup to restore (0 = oldest kept). Omit for the most recent."),
        confirm_token: z.string().optional().describe("Token from the preview. Omit it first to see the current value next to the one that would be restored."),
      },
      handler: async ({ site_id, option, backup_index, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable("restore_plugin_settings");
        const ns = await requireHelper(client, "restore_plugin_settings");
        const preview = (await client.post<any>(`/${ns}/plugins/settings/restore`, { option, backup_index, dry_run: true })).data;
        // Bound to the values themselves, so a write in between invalidates the token.
        const fingerprint = fingerprintOp(["restore_plugin_settings", client.site.id, option, preview?.index, preview?.fingerprint]);
        if (!confirm_token) {
          const token = await issueConfirmation(client.site.id, `restore_plugin_settings ${option}`, fingerprint);
          return ok({ restored: false, dry_run: true, ...preview, fingerprint: undefined, confirm_token: token },
            "This is a preview — nothing was written. Compare current with restore_to, then re-run with this confirm_token. The current value is backed up before the restore, so it can be undone the same way.");
        }
        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) return ok({ restored: false, refused: true, reason: check.reason }, "The confirmation was not accepted, so nothing was written.");
        const res = await client.post<any>(`/${ns}/plugins/settings/restore`, { option, backup_index: preview?.index });
        audit({ site: client.site.id, tool: "restore_plugin_settings", action: "restore", target: option, outcome: "ok" });
        return ok(res.data);
      },
    }),

    /* ------------------------ submit_admin_form ------------------------ */
    defineTool({
      name: "submit_admin_form",
      destructive: true,
      title: "Submit a wp-admin settings form",
      description:
        "Fill in and submit a form on a wp-admin screen as the administrator — the way to change plugin settings that live only on a wp-admin page with no REST route. First call is a dry run: it fetches the page, locates the form (by index or id), applies your `changes` on top of the current field values (hidden fields, nonce and referer included automatically; unchecked checkboxes handled correctly), and returns the diff of changed fields plus a confirm_token. Second call re-fetches the page for a fresh nonce, verifies the other field values have not changed since the preview, submits the form same-site, follows the redirect, and reports the resulting notices (e.g. \"Settings saved.\") and the new values. Unknown field names are refused with suggestions. Forms with file inputs, and screens that manage plugins/themes/users/exports/core updates, are refused — dedicated tools with proper guardrails exist for those.",
      schema: {
        site_id: siteIdSchema,
        page: z.string().describe("The wp-admin screen the form is on, e.g. \"options-general.php\" or \"admin.php?page=wpseo_titles\"."),
        form_index: z.number().int().min(0).optional().describe("Which form on the page (0-based). Use this or form_id."),
        form_id: z.string().optional().describe("The form's HTML id, if it has one. An alternative to form_index."),
        changes: z.record(z.string(), z.any()).describe("Field name → new value. Checkboxes accept true/false; selects and radios accept one of their option values."),
        allow_sensitive: z.boolean().optional().default(false).describe("Permit changing a password-type field. Off by default; a dedicated tool is usually safer."),
        force_incomplete_form: z.boolean().optional().default(false).describe("DANGEROUS: submit even though the completeness check found options the form would not send (options.php blanks them) or controls the parser missed. Only for a human-verified case; it can wipe plugin or site settings."),
        confirm_token: z.string().optional().describe("Token from the dry-run preview, required to actually submit."),
      },
      handler: async ({ site_id, page, form_index, form_id, changes, allow_sensitive, force_incomplete_form, confirm_token }) => {
        const client = site(site_id);
        client.assertWritable("submit_admin_form");
        const ns = await requireHelper(client, "submit_admin_form");
        const flow = newFlowId();

        const relPath = normalizeAdminPath(page);
        const forbidden = FORBIDDEN_SUBMIT.find((f) => f.re.test(relPath));
        if (forbidden) {
          return ok({ submitted: false, refused: true, reason: `This screen handles ${forbidden.why}; submitting it through this generic tool is refused. Use the dedicated tool for that operation.` }, "Nothing was submitted.");
        }

        const { structure, finalPath } = await fetchAdminPage(client, ns, relPath, flow);
        const form = pickForm(structure, form_index, form_id);
        if (!form) {
          return ok({ submitted: false, reason: `No form matched ${form_id ? `id "${form_id}"` : `index ${form_index ?? 0}`} on ${finalPath}. This page has ${structure.forms.length} form(s).`, forms: structure.forms.map((f) => ({ index: f.index, id: f.id, action: f.action, fields: f.fields.length })) }, "Nothing was submitted.");
        }

        if (form.method !== "post") {
          return ok({ submitted: false, refused: true, reason: "This is a GET form (a filter, search or navigation form), not a settings form. To see its result, call admin_page with the query string instead." }, "Nothing was submitted.");
        }
        // Reject file inputs and (unless allowed) password changes.
        if (form.fields.some((f) => f.file)) {
          return ok({ submitted: false, refused: true, reason: "This form has a file input; file uploads are not supported here. Upload files with create_media, or use the plugin's own tool." }, "Nothing was submitted.");
        }
        const changingSensitive = Object.keys(changes).some((k) => form.fields.find((f) => f.name === k && f.sensitive));
        // Core settings screens post to options.php, which writes each field as an option,
        // so the same protections as set_option apply (siteurl, home, default_role, …).
        const protectedFields = Object.entries(changes ?? {})
          .map(([name, v]) => ({ name, reason: protectedOptionReason(name.replace(/\[.*$/, ""), v) }))
          .filter((p) => p.reason);
        if (protectedFields.length) {
          return ok({ submitted: false, refused: true, reason: protectedFields.map((p) => p.reason).join(" "), fields: protectedFields.map((p) => p.name) }, "Nothing was submitted.");
        }
        if (changingSensitive && !allow_sensitive) {
          return ok({ submitted: false, refused: true, reason: "A field you are changing is a password/secret field. Pass allow_sensitive: true only if you are sure; a dedicated, guarded tool is usually the right way to change credentials." }, "Nothing was submitted.");
        }

        const known = form.fields.map((f) => f.name);
        const unknown = Object.keys(changes).filter((k) => !known.includes(k));
        if (unknown.length) {
          const suggestions: Record<string, string[]> = {};
          for (const u of unknown) suggestions[u] = closeMatches(u, known);
          return ok({ submitted: false, refused: true, reason: `Unknown field name(s): ${unknown.join(", ")}. They are not on this form.`, suggestions }, "Nothing was submitted. Fix the field names and try again.");
        }

        // Where the form posts, and whether that is allowed.
        const { path: actionPath, sameSite } = resolveActionPath(client, form, finalPath);
        if (!sameSite) {
          return ok({ submitted: false, refused: true, reason: `This form posts to "${form.action}", which is not a wp-admin URL on this site. Refusing to submit it.` }, "Nothing was submitted.");
        }
        const actionScript = actionPath.split("?")[0];
        if (!actionAllowed(actionScript)) {
          return ok({ submitted: false, refused: true, reason: `This form's action (${actionScript}) is not a settings endpoint (options.php, admin-post.php or a wp-admin screen).` }, "Nothing was submitted.");
        }
        const actionForbidden = FORBIDDEN_SUBMIT.find((f) => f.re.test(actionPath));
        if (actionForbidden) {
          return ok({ submitted: false, refused: true, reason: `This form's action handles ${actionForbidden.why}; refusing to submit.` }, "Nothing was submitted.");
        }

        if (!force_incomplete_form) {
          const problem = await completenessProblem(client, ns, form, actionPath, flow);
          if (problem) {
            audit({ site: client.site.id, tool: "submit_admin_form", action: "incomplete form", target: finalPath, outcome: "refused", detail: problem.reason.slice(0, 200) });
            return ok({ submitted: false, refused: true, ...problem, override: "force_incomplete_form: true (dangerous — can wipe settings)" }, "Nothing was submitted.");
          }
        }

        const built = buildFormBody(form, changes);
        const stableHash = fingerprintOp(stableFieldValues(form));
        const fingerprint = fingerprintOp(["submit_admin_form", client.site.id, finalPath, String(form.index), JSON.stringify(sortObj(changes)), stableHash, !!force_incomplete_form]);

        if (!confirm_token) {
          const token = await issueConfirmation(client.site.id, `submit_admin_form ${finalPath}#${form.index}`, fingerprint);
          audit({ site: client.site.id, tool: "submit_admin_form", action: "dry-run", target: finalPath, outcome: "dry-run" });
          return ok({
            submitted: false, dry_run: true,
            page: finalPath, form_index: form.index, form_id: form.id,
            action: actionPath,
            changed_fields: built.changed,
            confirm_token: token,
          }, built.changed.length
            ? "This is a dry run — nothing was submitted. Review the changed fields, then re-run with this confirm_token to submit. On submit the page is re-fetched for a fresh nonce and refused if its other values changed in the meantime."
            : "None of your changes differ from the form's current values, so submitting would be a no-op. Re-run with the confirm_token only if you still want to post the form.");
        }

        const check = await consumeConfirmation(confirm_token, fingerprint);
        if (!check.valid) {
          return ok({ submitted: false, refused: true, reason: check.reason }, "The confirmation was not accepted (the page or your changes differ from the preview), so nothing was submitted.");
        }

        // Re-fetch for a fresh nonce and rebuild the body against current values.
        const fresh = await fetchAdminPage(client, ns, relPath, flow);
        const freshForm = pickForm(fresh.structure, form.index, form.id);
        if (!freshForm) {
          return ok({ submitted: false, refused: true, reason: "The form disappeared from the page between preview and submit." }, "Nothing was submitted.");
        }
        const freshStable = fingerprintOp(stableFieldValues(freshForm));
        if (freshStable !== stableHash) {
          return ok({ submitted: false, refused: true, reason: "The form's field values changed between the preview and now (someone else may have saved the screen). Re-run without a confirm_token to preview the current state." }, "Nothing was submitted.");
        }

        const { path: freshAction } = resolveActionPath(client, freshForm, fresh.finalPath);
        if (!force_incomplete_form) {
          const problem = await completenessProblem(client, ns, freshForm, freshAction, flow);
          if (problem) {
            audit({ site: client.site.id, tool: "submit_admin_form", action: "incomplete form", target: finalPath, outcome: "refused", detail: problem.reason.slice(0, 200) });
            return ok({ submitted: false, refused: true, ...problem, override: "force_incomplete_form: true (dangerous — can wipe settings)" }, "Nothing was submitted.");
          }
        }
        const freshBuilt = buildFormBody(freshForm, changes);
        const posted = await tokenisedRequest(client, ns, freshAction, "POST", freshBuilt.body, flow);
        if (posted.authFailed) {
          return ok({ submitted: false, refused: true, reason: "The POST was redirected to the login screen — the admin token was not accepted." }, "Nothing was submitted.");
        }
        audit({ site: client.site.id, tool: "submit_admin_form", action: "submit", target: freshAction, outcome: "ok", detail: freshBuilt.changed.map((c) => c.name).join(",").slice(0, 200) });

        // Follow the redirect (same-site) to the result page and read its notices.
        let resultPath = fresh.finalPath;
        if (posted.location) {
          const dest = new URL(posted.location, posted.finalUrl);
          if (isSameSite(client.site.url, dest) && /wp-admin/.test(dest.pathname)) resultPath = normalizeAdminPath(dest.pathname + dest.search);
        }
        const result = await fetchAdminPage(client, ns, resultPath, flow).catch(() => null);
        const verifyForm = result ? pickForm(result.structure, form.index, form.id) : null;
        const newValues: Record<string, string | boolean | undefined> = {};
        const collateral: Array<{ name: string; before: string; after: string }> = [];
        if (verifyForm) {
          for (const c of freshBuilt.changed) {
            const f = verifyForm.fields.find((x) => x.name === c.name);
            if (f) newValues[c.name] = f.type === "checkbox" ? !!f.checked : f.value;
          }
          collateral.push(...collateralChanges(freshForm, verifyForm, new Set(Object.keys(changes))));
        }

        return ok({
          submitted: true,
          page: finalPath,
          posted_to: freshAction,
          post_status: posted.status,
          result_page: resultPath,
          notices: result?.structure.notices ?? [],
          changed_fields: freshBuilt.changed,
          values_after_save: newValues,
          collateral_changes: collateral.length ? collateral : undefined,
        }, collateral.length
          ? `WARNING: ${collateral.length} field(s) you did not ask to change now differ on the reloaded screen (see collateral_changes) — the plugin may have normalised them, or the form was not fully captured. Review them; restore_plugin_settings or another submit can put them back.`
          : (result?.structure.notices ?? []).some((n) => /saved|updated/i.test(n.text))
          ? "The form was submitted and WordPress reported the settings were saved. The values above are read back from the reloaded screen."
          : "The form was submitted. Check the notices and read-back values above to confirm the change took effect.");
      },
    }),
  ];
}

/** Unchanged fields whose value differs between the pre-submit form and the reloaded one. */
export function collateralChanges(before: AdminForm, after: AdminForm, changed: Set<string>): Array<{ name: string; before: string; after: string }> {
  const a = new Map(stableFieldValues(after));
  const out: Array<{ name: string; before: string; after: string }> = [];
  for (const [name, value] of stableFieldValues(before)) {
    if (changed.has(name) || !a.has(name)) continue;
    if (a.get(name) !== value) out.push({ name, before: value, after: a.get(name)! });
  }
  return out;
}

/** Pick a form by id (preferred) or index; default to the first form. */
function pickForm(structure: AdminStructure, index?: number, id?: string): AdminForm | undefined {
  if (id) return structure.forms.find((f) => f.id === id);
  if (typeof index === "number") return structure.forms[index];
  return structure.forms[0];
}

/** Deterministic key order for hashing a changes object. */
function sortObj(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.keys(obj).sort().map((k) => [k, obj[k]] as [string, unknown]);
}

export { normalizeAdminPath, actionAllowed, isLoginRedirect, FORBIDDEN_SUBMIT, VOLATILE_FIELDS };
