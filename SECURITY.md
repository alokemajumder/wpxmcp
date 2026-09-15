# Security policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/alokemajumder/wpxmcp/security/advisories/new). Please do not open a public issue for a security problem.

Include what you did, what happened, and what you expected. You will get an acknowledgement within 72 hours and an assessment within a week.

---

## Threat model

wpxmcp gives a language model write access to production websites. The assumption behind every guardrail here is that **the model will sometimes be confidently wrong**, and that the damage from that must be bounded, previewed, and reversible.

The inputs a model acts on are not trustworthy either. Page content, comments, plugin settings screens and error logs can all carry text written by someone else, so a tool must stay safe even when the model has been talked into a bad call: it must not become a proxy into the server's network, a way to reach another host with the site's credentials, or a way around a guard that another tool enforces.

The design goals, in priority order:

1. Nothing irreversible happens without an explicit, argument-bound confirmation.
2. Credentials are never disclosed, logged, or returned by any tool.
3. The site's own permission model is respected rather than bypassed.
4. Tools reach only the configured site, and public addresses, never the server's private network.
5. Every sensitive action leaves a record.

The surfaces that carry the most risk, and where the guardrails below concentrate:

| Surface | What could go wrong | Section |
| --- | --- | --- |
| The remote Worker | Anyone driving your sites through it | [Authentication](#authentication), [Protocol and transport](#protocol-and-transport) |
| Outbound fetches (`get_page_html`, `create_media`, `check_links`, probes) | SSRF into internal services or cloud metadata | [Outbound requests](#outbound-requests) |
| SQL, WP-CLI, snippets, theme files | Data loss, code execution | [SQL](#sql), [WP-CLI](#wp-cli), [Themes and code](#themes-and-code) |
| Profiling and wp-admin access over tokens | A token that authenticates someone else | [Profiler and admin tokens](#profiler-and-admin-tokens) |
| Plugin settings and admin forms | Silent misconfiguration, destructive admin actions | [Plugin settings and admin forms](#plugin-settings-and-admin-forms) |
| Diagnostics output | Secrets in logs, options and error messages | [Secret redaction](#secret-redaction) |

---

## Guardrails

### Authentication
- **Application Passwords** — revocable per-integration, never the account password. Sent over HTTPS with Basic auth, which is the mechanism WordPress designed for this.
- **Roles are enforced by WordPress**, not by this server. An Editor's token cannot install a plugin regardless of what a tool is asked to do.
- **The companion plugin requires an administrator** (`manage_options`) on every route, and **a network super admin on multisite**, because its routes reach network-wide data.
- **Capabilities WordPress withholds are honoured.** Theme-file writes, drafts, scaffolds and publishes require `edit_themes`, so `DISALLOW_FILE_EDIT` and `DISALLOW_FILE_MODS` switch them off; WP-CLI plugin and theme installs, updates, activations and deletions check `install_plugins`, `update_plugins`, `activate_plugins`, `delete_plugins`, `install_themes`, `update_themes` or `switch_themes`.
- **Remote deployments require a bearer token.** A Worker with no `WPX_AUTH_TOKEN` refuses every request rather than running wide open, and the token is compared in constant time.

### Protocol and transport
- **Stateless.** The Worker builds a fresh MCP server per request and serves both MCP 2026-07-28 and 2025-era clients from one endpoint; there is no MCP session to hijack or leak between callers.
- **Bounded requests.** A body whose declared size exceeds 32 MiB is refused with `413` before a server is built.
- **CORS is an allowlist.** `WPX_ALLOWED_ORIGINS` is empty by default, so no browser origin is allowed; the bearer token is required whatever the origin.
- **The health endpoint reveals nothing** about the configured sites: service, version, runtime, supported protocol revisions and whether a token is configured.
- **Redirects are followed by hand.** The REST client refuses a redirect to another origin — where custom site headers such as Cloudflare Access tokens would otherwise be forwarded — and refuses one that would turn a write into a body-less GET.

### Destructive operations
- **Content deletes go to the trash.** Permanent deletion requires `force` **and** `confirm`, and first returns what would be destroyed. Trashing goes through DELETE, so a site with the trash disabled refuses instead of deleting permanently.
- **Term, user, media and plugin deletion** — which have no trash — always preview and require `confirm`.
- **Bulk edits, `search-replace`, mutating SQL, options cleanup, SEO meta writes, style variations, template resets, plugin settings writes and admin form submissions** produce a preview plus a single-use `confirm_token`, fingerprinted against the exact arguments. Change one argument and the token no longer matches.
- **Tokens are bound to state, not only arguments,** where the target can change between preview and apply: a bulk update is bound to each matched item's modification time, a plugin settings write to the option's current value, and a form submission to the form's other field values.
- **Tokens expire after 10 minutes**, are HMAC-signed, and are refused once spent.

### SQL
- SELECT/SHOW/DESCRIBE/EXPLAIN/WITH only, by default.
- **Inspected the way MySQL parses it.** A lexer handles quoted strings and identifiers, doubled quotes, `-- ` and `#` comments, and executable `/*! … */` comments (whose contents run, so they are inspected as code). Keywords are matched as whole words outside string literals, under both backslash-escape modes, so neither a post titled "How to delete a page" nor a keyword hidden in a comment is misjudged.
- **Stacked statements are always refused**, on both sides.
- `SLEEP`, `BENCHMARK`, `GET_LOCK` and `LOAD_FILE` need approval like a mutation.
- **The plugin refuses file access in every mode:** `INTO OUTFILE`, `INTO DUMPFILE`, `LOAD_FILE` and `LOAD DATA`.
- **Read-only queries run inside `START TRANSACTION READ ONLY`** on the plugin side, because `WITH … DELETE` and `EXPLAIN ANALYZE` execute despite a harmless first keyword.
- An unbounded SELECT gets a `LIMIT`, applied in the database rather than after loading every row.
- Mutations need three independent things: `allow_mutation: true`, a valid `confirm_token`, and `WPXMCP_ALLOW_SQL_WRITES` in `wp-config.php`.

### WP-CLI
- **Default-deny allowlist.** Anything not listed is refused, enforced independently in both the server and the plugin.
- Shell metacharacters are rejected. Commands are emulated in PHP and never reach a shell.
- `wp eval` is not available at all: arbitrary PHP has no path through the WP-CLI emulation.
- **`search-replace` must be dry-run first — enforced by the plugin**, not only the server: a real run is refused unless the same user dry-ran the same replacement within the last ten minutes, and the dry run is consumed. It never touches the plugin's own `wpxmcp_` options, and leaves corrupt serialised values alone rather than destroying them.
- The server's dry-run detection parses the command exactly as the plugin does, so `--dry-run-x`, a quoted `--dry-run` or `--dry-run=0` cannot pass for a dry run.
- **Protected options** cannot be updated or deleted: see [Themes and code](#themes-and-code).

### Themes and code
- **Writing to a live theme is refused** unless explicitly overridden. The workflow is draft → preview → publish. Only wpxmcp drafts can be published, and a theme with a broken header or missing parent is refused before anything changes.
- **Publishing backs up the previous theme first**, and aborts entirely if that backup fails. A partial copy is treated as a failure and removed.
- **PHP is syntax-checked before it is written**, so a parse error is reported instead of fataling the site.
- **Path traversal is blocked**: theme names must be a single path segment (not `.` or `..`); paths with `..`, null bytes, drive letters or stream wrappers are refused; the target is resolved through its nearest existing ancestor so a symlink cannot escape; extensions are allowlisted. Symlinks are never copied into drafts or backups.
- **Generated themes cannot be injected into.** Names, descriptions and authors are reduced to one comment-safe line before they reach `style.css` or a PHP docblock, and design tokens cannot close the CSS rule they sit in.
- **Snippets are always created disabled** and can only be activated by a human in wp-admin. **Changing an active snippet's code disables it** until it is reviewed again. A snippet that throws, or causes a fatal error, disables itself. If the site is still down, `define( 'WPXMCP_SAFE_MODE', true );` in `wp-config.php` skips every snippet.
- **Protected options.** One list, shared by every write path in the plugin (`/options`, WP-CLI `option update` and `option delete`, editable fields, options cleanup, plugin settings writes and restores): `siteurl`, `home`, `active_plugins`, `active_sitewide_plugins`, `template`, `stylesheet`, `cron`, `db_version`, `rewrite_rules`, `upload_path`, `upload_url_path`, `default_role`, any `*_user_roles`, the auth/secure_auth/logged_in/nonce keys and salts, and everything prefixed `wpxmcp_` — so the snippet store cannot be switched on and the audit log cannot be erased through an option write. The server's `set_option` refuses a similar list before a request is made.

### Outbound requests
- **Page fetches stay on the site.** `get_page_html`, `check_accessibility`, `profile_url`, `purge_cache` verification, `security_audit` probes, SEO checks and the wp-admin fetches behind `admin_page` resolve their target against the configured site and refuse any other host. Relative inputs are always paths (`//evil.example` and `\\evil.example` cannot become another host), and every redirect hop is re-checked; a redirect off the site is reported, not followed.
- **Downloads refuse private addresses.** `create_media` with `url` and `check_links` for external links accept only http(s), and refuse loopback, private, link-local (including cloud metadata), CGNAT, multicast and reserved addresses — IPv4, IPv6 and IPv4-mapped forms, including obfuscated literals — and `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa` and single-label hostnames. Every redirect hop is re-validated.
- **DNS rebinding is checked on Node.** Before connecting, the local server resolves the hostname and refuses it if any address is private. Workers have no DNS lookup in this code path, so there the check is on the hostname and IP literal only.
- **`WPX_ALLOW_PRIVATE_URLS=true`** lifts the private-address refusal for a trusted intranet. The configured WordPress host is always allowed without it, so a local development site works.
- **Bodies are capped** and read as a stream, so a huge or endless response cannot exhaust memory: 5 MB for `get_page_html`, 1 MB or less for SEO and link checks, at most 256 KB for security probes, 128 MB for a media download.
- **External services are named, and optional.** `security_audit` sends the core version and the slugs of installed plugins and themes to the public WPVulnerability API (`include_vulnerabilities: false` turns it off); plugin and theme search call WordPress.org; stock-photo search calls the provider you configured. Beyond those, the server contacts only your sites and the URLs a tool is explicitly given or asked to check (`create_media` downloads, `check_links` external links).

### Profiler and admin tokens
`profile_url` and `get_template_for_url` profile a front-end request, and `admin_page`, `submit_admin_form`, `inspect_plugin` and `list_admin_pages` load wp-admin screens. Neither can send the Application Password to the front end, so the plugin issues a token instead:

- **Issued only to an administrator** over authenticated REST (a super admin on multisite), and checked again when used: the issuing user must still hold `manage_options`.
- **Random, single use and short-lived.** 32 random characters, valid for **two minutes**, deleted the moment a request presents it — before anything else runs.
- **Stored only as a keyed hash** (HMAC-SHA256 with the site's nonce salt), so the options table never holds a usable token.
- **Bound to one request.** A profiler token is bound to the path and query string it was issued for; an admin token to the wp-admin script, query string and HTTP method. A token presented anywhere else is consumed and ignored.
- **Rate-limited** to 20 outstanding tokens per user.
- **Never cached.** Token-carrying responses set `DONOTCACHEPAGE` and no-cache headers.
- **No lingering session.** An admin token authenticates that one request in memory: no `Set-Cookie` header reaches the caller, the token is removed from the request so WordPress does not echo it into forms or redirects, and the session created for the request is destroyed at shutdown. The session is derived from the user and a per-operation flow id, so the requests of one form submission share it (the form's nonce stays valid) while separate operations never do.
- **Reports are private.** A profile report can be collected only by the user who requested it, and is deleted when read unless `keep` is passed.
- **Viewing, not acting.** An admin token for a GET request cannot carry a nonce parameter — such a URL performs an action (activate, delete, trash) rather than showing a screen — and admin tokens cannot POST to network-admin screens.
- **Ordinary traffic is unaffected**: requests without the parameter pay one `isset()` check, and invalid tokens are ignored silently.

### Plugin settings and admin forms
- **Writes go through WordPress.** `update_plugin_settings` calls `update_option()`, so a sanitize callback attached to the option runs; the result reports whether one ran and which fields it changed or dropped, and warns when a plugin registers its settings only inside wp-admin.
- **Every overwritten value is backed up** — the last five per option, in a non-autoloaded option — and `restore_plugin_settings` backs up the current value before restoring, so a restore is itself undoable. (A restore applies immediately, without a preview.)
- **Scoped to the plugin.** A write is refused unless the option is attributable to the named plugin (its registered settings or option prefixes), unless `force_option` is passed. Protected options are refused regardless.
- **Forms are refused when they could do damage.** `submit_admin_form` will not submit screens that manage plugins, plugin or theme files, theme installs, user creation or deletion, site export or core updates; forms with file inputs; GET forms; forms whose action leaves wp-admin on this site or is not a settings endpoint; field names that are not on the form; or a change to a password or secret field without `allow_sensitive`. `admin_page` refuses URLs that carry a nonce.
- **Incomplete forms are refused.** `options.php` saves every option in a settings group and blanks any it is not sent, so before submitting to it the tool reads the exact option list `options.php` enforces for that group and refuses when the parsed form lacks a field for any of them. It also refuses when fewer named controls were parsed than the form's HTML contains. `force_incomplete_form` overrides both, and is described as able to wipe settings.
- **Previewed against a fresh page.** The submit re-fetches the screen for a new nonce and refuses if any other field changed since the preview. Afterwards it reloads the screen and reports fields that changed without being asked.

### Secret redaction
- **No tool returns a credential.** `list_sites` and `get_site` report the *method*, never the value.
- **Configuration errors do not echo input.** A JSON parse error in `WPX_SITES` or a sites file reports only the position, since the surrounding text may be a password.
- **Plugin settings** are returned with values under secret-looking keys (`pass`, `secret`, `token`, `api_key`, `license`, `private_key`) masked to `••••` plus the last four characters, unless `reveal: true` is passed. `admin_page` omits the values of password and secret-looking fields.
- **Error logs and diagnostics** have absolute install paths rewritten as relative ones. The fatal-error recorder stores the request path but drops the query string, which can carry tokens.
- **Profiler reports** strip query-string values (keeping the names) and credentials from every URL they list.
- **`security_audit` evidence** about an exposed file is a short excerpt with passwords, keys and salts redacted — never the file.

### Content defaults
- `create_content` **defaults to draft**. Publishing is always explicit.
- Sites can be marked `"writable": false`, refusing every write at the server. The flag must be a real boolean, so a string `"false"` cannot leave a site writable.
- `rest_api` counts a `_method` override as the method WordPress will dispatch, so a disguised write needs a writable site and is audited.

### Auditing
- An append-only JSONL log locally (`~/.wpxmcp/audit.log.jsonl`), readable via `get_audit_log`.
- An independent append-only record on each WordPress site, kept by the companion plugin (the last 500 entries in the `wpxmcp_audit_log` option), including every admin token issued and used, settings write and restore, cache purge, options cleanup and WP-CLI write.

---

## Handling of credentials

- Credentials are read from the environment, a local JSON file, or Cloudflare Worker Secrets.
- **No tool returns a credential**, and a test asserts this.
- Credentials are not written to the audit log.
- On Workers they live in Cloudflare's encrypted secret store, are not readable back, and are never present in the repository or in any client's configuration.
- The local confirmation-token key (`~/.wpxmcp/confirm.key`) is created with mode `0600`; a key shorter than 32 characters is never trusted.

**Your responsibilities:** keep `.env`, `sites.json` and `.dev.vars` out of version control (all are gitignored); use the least-privileged role that does the job; rotate by revoking the Application Password in wp-admin.

---

## Dependencies

- **Three runtime dependencies**: `@modelcontextprotocol/server`, `undici` (used only on Node, for `allowInsecureTLS`) and `zod`. The Worker bundle has nothing else.
- **Dependabot** opens weekly npm updates: development dependencies grouped by minor and patch, production dependencies grouped by patch, and the pinned GitHub Actions monthly.
- **Major versions are taken deliberately**, never automatically, for `@modelcontextprotocol/*` (they set the protocol revisions this server speaks), `undici` (it must match the undici inside Node's own fetch) and `@types/node` (it tracks the oldest supported Node).
- **CI** type-checks, builds and tests on Node 20, 22 and 24, lints the plugin on PHP 7.4 and 8.3, and builds the Worker, on every push to `main` and every pull request against it.

---

## Known limitations

- **This is not a sandbox.** An administrator credential can do administrator things. Guardrails constrain accidents, not a determined operator.
- **Spent confirmation tokens are remembered per process.** On Workers, where requests land on different isolates, a spent token could be accepted once more by another isolate within its 10-minute life. The token is still bound to the same arguments and state.
- **`allowInsecureTLS: true` disables certificate verification** for that site (on Node; Workers ignore it). It exists for staging boxes with self-signed certificates; never use it on a site that matters.
- **Raw SQL bypasses WordPress hooks**, so caches are not invalidated and plugin logic does not run. Tools that expose it say so.
- **A plugin settings write may skip the plugin's validation** when the plugin registers its sanitizer only inside wp-admin. The tool detects and reports this; the plugin's own settings screen, through `submit_admin_form`, is the sanitized path.
- **Secret redaction is pattern-based.** A secret stored under an innocuous key, or an option whose whole value is a secret, is not masked.
- **Workers audit logging is best-effort** unless you bind KV — isolates are evicted freely. The site-side log does not have this limitation.
- **Caches outside WordPress are out of reach.** `purge_cache` clears what WordPress can call; a CDN or server cache in front of the site keeps its copy until purged there.
- **`get_page_html` and `check_accessibility` do not execute JavaScript.** They read server-rendered HTML, and say so.
