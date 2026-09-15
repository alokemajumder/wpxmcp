# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-09-15

A protocol migration, 33 new tools, 11 new playbooks, and a line-by-line audit of the server and the companion plugin. **Update the companion plugin together with the server**: the new plugin-backed tools call routes a 1.0.0 plugin does not have, and say so when they meet one.

### Breaking and changed

**Protocol and SDK**
- Moved from `@modelcontextprotocol/sdk` v1 to `@modelcontextprotocol/server` v2, and from zod 3 to zod 4.
- Serves **MCP 2026-07-28** — stateless, no `initialize` handshake, `server/discover`, a per-request `_meta` envelope — **and** 2025-era clients (`2025-11-25`, `2025-06-18`, `2025-03-26`) from the same endpoint, over both stdio (`serveStdio`) and HTTP (`createMcpHandler`). The hand-written stateless HTTP transport is gone.
- Both entry points now build the server through one `createWpxServer` (`src/lib/server.ts`). `tools/list` carries a one-hour private cache hint for 2026-07-28 clients.
- Raw HTTP requests must send `Accept: application/json, text/event-stream`; without it the server answers `406`. Requests over 32 MiB (by `Content-Length`) are refused with `413`.
- The Worker's CORS headers now allow `Accept`, `Mcp-Method` and `Mcp-Name` and expose `WWW-Authenticate`, and are sent on `401`/`503` refusals too. `/health` reports the supported `protocol` revisions.

**Removed**
- `WPX_ALLOW_EVAL` and the `eval` entry on the WP-CLI allowlist. The plugin never implemented `eval`; neither did it implement `site list`, `user create`, `user update` or `language core list`, which are also gone from the allowlist rather than failing after the fact.

**Stricter by default**
- `get_page_html` fetches only pages on the configured site; other hosts, and redirects to them, are refused. Bodies are capped at 5 MB.
- `create_media` with `url` refuses private, loopback, link-local and local-network addresses, including after redirects and (on Node) after DNS resolution. The WordPress site's own host is always allowed; `WPX_ALLOW_PRIVATE_URLS=true` lifts the rest.
- The REST client no longer follows a redirect to another origin, or one that would turn a write into a GET; it stops and says which URL to configure instead.
- Site configuration is validated when it loads: `writable` and `allowInsecureTLS` must be real booleans (so `"writable": "false"` can no longer leave a site writable), `timeoutMs` must be positive, and a pasted `/wp-json` on `url` is stripped.
- `rest_api` treats a `_method` override as the method WordPress will dispatch, so `GET ?_method=DELETE` needs a writable site and is audited.
- `set_option` refuses role tables, salts, `default_role`, core bookkeeping options (`cron`, `db_version`, `rewrite_rules`, upload paths and others) and anything prefixed `wpxmcp_`.
- Companion plugin: on multisite every route requires a network super admin; theme-file writes, drafts, scaffolds and publishes require `edit_themes`, so `DISALLOW_FILE_EDIT` and `DISALLOW_FILE_MODS` are honoured; plugin and theme installs, updates, activations and deletions through WP-CLI check the matching capability.
- Companion plugin: `search-replace` refuses a real run unless the same user dry-ran the same replacement in the last ten minutes, enforced site-side.
- Companion plugin: `/themes/publish` publishes only wpxmcp drafts, and refuses a theme with a broken header or a missing parent before touching anything.
- Companion plugin: changing the code of an **active** snippet deactivates it until it is re-approved in wp-admin.
- Companion plugin: `cron event run` runs only events that are actually scheduled, with their scheduled arguments, instead of firing an arbitrary action with none.
- `list_media` no longer offers the `file` media type (WordPress rejects it); `bulk_update_content` no longer offers `future` as a status to set.

**Documentation**
- `docs/TOOLS.md` is generated from the built toolset (`npm run docs:tools`) and checked for staleness in CI.

### Added

**Operations and security** (`src/tools/ops.ts`)
- `tail_error_log` — the end of the PHP error log, duplicate entries grouped and attributed to the plugin, theme or core file, with `WP_DEBUG*` state and the last fatal error the plugin recorded even when logging is off.
- `purge_cache` — purges through each cache layer's own API (WP Rocket, LiteSpeed, W3 Total Cache, WP Super Cache, WP Fastest Cache, SiteGround, Cache Enabler, Breeze, Hummingbird, Nginx Helper, Autoptimize, Proxy Cache Purge, WP-Optimize, the Cloudflare plugin, Kinsta, WP Engine, Pantheon, GoDaddy, and page-builder CSS caches), then re-fetches the page and reports its cache headers.
- `security_audit` — a 0–100 score with prioritised findings: anonymous outside-in probes (user enumeration, XML-RPC, public `debug.log`, exposed `wp-config` backups, `.git`, `.env`, directory listing, headers, version leaks, HTTPS), configuration checks through the plugin, and core/plugin/theme versions against the WPVulnerability database.
- `backup_status` — which backup plugin is in use and how old the last completed backup is.

**Performance profiling** (`src/tools/profiler.ts`)
- `profile_url` — Query Monitor over MCP for one front-end URL: template, every query with caller and component, duplicates, outbound HTTP calls, PHP warnings, assets, hooks, conditionals, memory and timing, as a visitor or as the administrator.
- `get_template_for_url` — which template file or block template renders a URL, and the hierarchy WordPress tried.

**Developer introspection** (`src/tools/devtools.ts`)
- `inspect_registry` — post types, taxonomies, meta, blocks, shortcodes, REST routes, hooks (with each callback's `file:line`), cron, image sizes, menus, sidebars, capabilities, scripts and styles, attributed to the plugin, theme or core file that registered them.
- `inspect_options` and `cleanup_options` — autoload weight against Site Health's 800 KB threshold, per-owner rollups and transient hygiene; cleanup previews and needs a `confirm_token`, and refuses core and protected options.
- `inspect_database` — tables with engine, collation, size, overhead and owning plugin, orphaned rows, revisions, auto-drafts, spam and non-utf8mb4 tables.

**Theme development** (`src/tools/themedev.ts`)
- `diff_global_styles`, `reset_template_customization`, `list_style_variations`, `apply_style_variation`, `list_block_patterns`, `validate_theme_json` (including WCAG contrast across style variations) and `check_accessibility`.

**SEO, content and fleet** (`src/tools/growth.ts`)
- `get_seo_meta` and `set_seo_meta` across Yoast, Rank Math, AIOSEO, SEOPress and The SEO Framework, comparing stored values with what the page renders; writes preview and need a `confirm_token`.
- `seo_site_check`, `check_links`, `internal_link_report`, `content_inventory` (with CSV), `content_calendar` and `fleet_report`.

**Operating installed plugins** (`src/tools/plugin-control.ts`)
- `inspect_plugin`, `list_admin_pages`, `admin_page`, `get_plugin_settings`, `update_plugin_settings`, `restore_plugin_settings` and `submit_admin_form` — read and change any plugin's settings and wp-admin screens as the administrator, with previews, confirmation tokens, secret redaction and backups of every overwritten value. `submit_admin_form` refuses a form that would blank settings: it checks the option group `options.php` enforces and how many of the form's controls were parsed (`force_incomplete_form` overrides).

**Themes**
- `search_themes` — search the WordPress.org theme directory.

**More from existing tools**
- `site_info` runs core's REST-exposed Site Health tests (loopback, HTTPS, background updates, page cache, Authorization header) without the plugin.
- `list_content` gains `include`, `exclude` and `sticky`, and sends `fields` as `_fields`.
- `list_comments` gains `type`; `update_comment` and `moderate_comments` gain `unspam` and `untrash`.
- `get_global_styles` gains `include_theme_defaults`; `update_global_styles` gains `merge` for a deep merge.
- `bulk_update_content` gains `remove_tags`; `audit_content` reports duplicate slugs.
- `publish_draft_theme` warns when the live theme has Site Editor customisations the draft will not carry.
- `discover_abilities` walks every page of abilities and returns their annotations.
- `delete_user` previews authored pages as well as posts, and validates `reassign_to`.
- `create_content` warns when a `future` date was not in the future and WordPress published immediately.
- `get_content` and the update tools warn when an item looks like page-builder content.

**Playbooks**
- Eleven new: `accessibility`, `content-publishing`, `fleet-maintenance`, `performance`, `plugin-settings`, `security-hardening`, `site-down`, `site-launch`, `theme-json`, `woocommerce` and `wp-developer` — 20 in all, every one restructured into the same When this applies / Rules / Procedure / Verify / Report back shape.

**Companion plugin**
- New classes for diagnostics (error log, fatal-error recorder, cache purge, security facts, backup detection), introspection (registry, options, database, options cleanup), per-request profiling, and plugin administration. The full route table is in [docs/COMPANION_PLUGIN.md](docs/COMPANION_PLUGIN.md).
- `WPXMCP_SAFE_MODE` in `wp-config.php` skips every snippet, for a snippet that takes the site down.

**Quality**
- Tests for the tool contract (every tool and parameter described, schemas convert to JSON Schema and are served by `tools/list`), playbook accuracy (every tool, parameter, literal value and WP-CLI command a playbook names must exist), playbook routing, both protocol eras over the HTTP transport, and the helpers behind every new tool module.
- The live audit suites run over both protocol eras (`WPX_AUDIT_ERA=legacy`), and measure coverage against the live `tools/list` instead of a checked-in snapshot.
- A `companion` field on tool definitions, for tools that reach the plugin indirectly.

### Fixed

**REST client and configuration**
- A redirected POST was silently re-sent as a body-less GET and reported success; custom site headers were forwarded to whatever origin a redirect named.
- JSON preceded by PHP notices (`display_errors` on) was returned as a string; it is now recovered, and JSON that cannot be parsed is reported as such.
- The request timeout now covers the response body, so a server that sends headers and stalls cannot hang a call.
- A route carrying its own query string broke on `?rest_route=` sites.
- `hasHelperPlugin` treated an unreachable site or rejected credentials as "plugin not installed", so tools told people to install a plugin they had.
- A `WPX_SITES` parse error quoted the surrounding JSON, which could include a password.
- A read-only home directory stopped the local server from starting; a truncated `confirm.key` was trusted, and two servers starting together could overwrite each other's key.

**Content, taxonomies, comments, users**
- Post types and taxonomies with a custom `rest_namespace` were addressed under `/wp/v2` and could not be read or written.
- Setting `status: "trash"` failed, because REST does not accept it as a status; it now goes through DELETE. Trashing comments the same way means `EMPTY_TRASH_DAYS = 0` no longer turns a trash into a permanent delete.
- `edits` could be applied to rendered HTML and written back, destroying block markup, when the credentials could not read raw content; they now refuse. `find_content_by_url` re-reads in edit context before editing.
- A regex edit matching several times replaced only the first match instead of failing as ambiguous; a replacement containing `$&` or `` $` `` spliced in other parts of the post.
- Edits that changed nothing discarded the other fields supplied in the same call.
- Term names stored HTML-escaped (`Q&amp;A`) did not match, so duplicates were created; a create that raced an existing term failed instead of reusing it.
- Terms for a taxonomy not attached to the type were created, then silently ignored by WordPress. Removing terms by name could create them.
- `create_content` with `status: "future"` and no date published immediately.
- `get_content_terms` dropped terms beyond the first 100.
- `delete_user` without `reassign_to` sent an empty value WordPress rejects.
- `discover_content_types` fell back to a published-only count for attachments; `get_content_by_slug` searched editor-internal types and gave up where the public listing would answer.

**Media, themes, plugins, appearance**
- `create_media` accepted an HTML page as an image, read unbounded bodies into memory, mangled non-ASCII and RFC 5987 filenames, dropped the source extension when `filename` had none, and hid the new attachment id when a follow-up step failed — so a retry uploaded a duplicate.
- `audit_media` missed `-scaled` and `-rotated` derivatives and did not say when a large site was only partly scanned.
- `delete_theme_file` sent `allow_live=false` as a query string the plugin read as true, lifting the live-theme guard on every delete.
- Theme scaffolding let a name, description or author inject theme headers or close a PHP docblock, let a design token break out of the `:root` rule, and produced invalid PHP for slugs starting with a digit.
- `read_theme_file` returned binary files as broken text; `get_theme` reported the wrong parent.
- Plugin, widget, template and theme identifiers could contain dot segments or query strings that addressed a different REST route.
- `delete_plugin` on an active plugin failed without explaining why; WordPress.org errors and timeouts surfaced as crashes.
- `add_menu_item` of type `post_type_archive` without `object` failed opaquely.

**Bulk operations and safety**
- A `bulk_update_content` confirmation stayed valid if the matched items changed after the preview; it is now bound to each item's modification time. One ambiguous item failed the whole batch.
- The SQL guard mis-read `'#fff'` as a comment and collapsed whitespace inside string literals (rewriting the data a mutation writes); now a MySQL-aware lexer handles quotes, `-- ` comments and executable `/*! */` comments, checks under both backslash-escape modes, allows `INSERT()`/`REPLACE()` string functions, flags `SLEEP`, `BENCHMARK`, `GET_LOCK` and `LOAD_FILE`, and adds `LIMIT` only when no top-level `LIMIT` exists.
- Confirmation fingerprints collided for non-ASCII arguments.
- `search-replace` dry-run detection could be fooled by `--dry-run-x`, a quoted `--dry-run`, or `--dry-run=0`.
- `load_skill` matching mishandled `-es` and `-ies` plurals; `save_skill` let a newline corrupt the front matter.

**Companion plugin**
- Meta written through `/meta` and WP-CLI lost every backslash, corrupting Elementor and other JSON documents.
- Autoload reports and queries ignored WordPress 6.6's `on`/`auto-on`/`auto` values.
- Several Site Health direct tests fataled over REST; booleans from query strings (`"false"`) were cast to true.
- SQL: trailing semicolons broke the appended `LIMIT`, row limits were applied in PHP after loading every row, and results did not say when they were truncated.
- `search-replace` destroyed corrupt serialised values, skipped rows silently past 5,000, and failed on objects of unloaded classes.
- Theme drafts copied through symlinks, left partial copies and backups behind on failure, and published with none of the live theme's theme mods; `header.php` starting with `<!DOCTYPE html>` failed the syntax check; a draft name could inject into `style.css`.
- A PHP snippet causing a fatal error (rather than an exception) was not disabled; HTML snippets were stored but never output.
- WP-CLI option, meta, theme-mod, transient, role and maintenance-mode writes were not all audited; list limits were unbounded; `maintenance-mode activate` did not warn that it also blocks REST.

### Security

- **SSRF.** `get_page_html` could be pointed at any host, and `create_media` at internal services or cloud metadata, both with the server's own network access. Page fetches now stay on the configured site with every redirect re-checked; downloads refuse private, loopback, link-local, CGNAT, multicast and reserved addresses (IPv4, IPv6 and mapped forms, obfuscated literals included), re-check every redirect hop, and on Node resolve the hostname first to close DNS rebinding.
- **Live-theme guard bypass.** `delete_theme_file` could delete from the live theme without `allow_live_theme` (see Fixed).
- **Theme path traversal.** The plugin accepted `.` and `..` as theme names, null bytes, drive letters and stream wrappers in paths, and a symlinked directory that did not exist yet; paths are now resolved through the nearest existing ancestor.
- **SQL.** Statements reading or writing server files (`INTO OUTFILE`, `INTO DUMPFILE`, `LOAD_FILE`, `LOAD DATA`) are refused in every mode, and read-only queries run inside `START TRANSACTION READ ONLY`, since `WITH … DELETE` and `EXPLAIN ANALYZE` execute despite a read-only first keyword. The plugin inspects statements with its own lexer, executable comments included.
- **Guard bypass through options.** A field group key, a settings-page save, `option update`/`option delete` or `search-replace` could write `wpxmcp_snippets` (activating PHP without wp-admin review), erase the audit log, or change role definitions, salts, `default_role` or upload paths. All write paths now share one protected-option list, and `search-replace` skips the plugin's own options.
- **Multisite privilege.** A sub-site administrator could reach network-wide SQL, plugin installs and theme files.
- **Unreviewed code.** Changing an active snippet's code ran the new code on the next request without review.
- **Code injection through scaffolding.** Theme names and tokens could inject PHP into a generated theme (see Fixed).
- **Forged confirmations.** An empty or truncated local `confirm.key` would have signed tokens anyone could forge; it is now rejected and regenerated.
- **Profiler and admin-screen access** use single-use, path-bound, two-minute tokens stored only as keyed hashes, rate-limited per user, and never cached; see [SECURITY.md](SECURITY.md).
- **Secrets in output.** Plugin settings are returned with secret-looking values redacted; error-log paths are made relative; the fatal-error recorder drops query strings; profiler reports strip query-string values and URL credentials; exposed-file evidence in `security_audit` is a short redacted excerpt.

## [1.0.0] — 2026-08-23

First release. Verified end to end against a live WordPress 7.1 install.

### Added

**Transports**
- Local stdio server for Claude Code, Claude Desktop, Cursor and any stdio MCP client.
- Remote Streamable HTTP server for Cloudflare Workers, with credentials in Worker Secrets, bearer-token auth, CORS control and a one-click deploy button.
- MCP protocol `2025-11-25`, with the SDK negotiating back to `2024-11-05`.

**Multi-site**
- `list_sites`, `get_site`, `test_site`, `get_audit_log`.
- Configuration from inline JSON, a file, per-site env triples, or single-site shorthand.
- Per-site read-only mode, custom REST prefixes, extra headers and timeouts.

**Content and taxonomy**
- Nine unified content tools covering posts, pages and any custom post type.
- Targeted find/replace edits that fail loudly on a miss and refuse ambiguous matches.
- URL resolution that detects custom post types from rewrite bases, the search index and slug sweeps.
- Eight unified taxonomy tools; terms may be given by name and are created if missing.

**Media**
- Upload from a local path, a remote URL, or base64, with the full WordPress image pipeline.
- Stock photo search via Unsplash or Pexels, with attribution.
- Alt-text auditing and unused-attachment detection.

**Design and appearance**
- Sandboxed theme drafts with private tokenised preview URLs and backed-up publishes.
- Classic PHP + Tailwind theme scaffolding with design tokens in one `theme.css`.
- Menus, widgets, sidebars, block templates, global styles and Customizer settings.

**Administration**
- Users, comments, plugins, site settings, revisions, site health and rendered page HTML.
- Emulated WP-CLI (50+ commands, default-deny allowlist, no binary required).
- Guarded SQL, the WordPress Abilities API, code snippets and editable fields with thirteen field types.
- `rest_api` and `discover_rest_routes` as escape hatches for plugin routes.

**Safety**
- Content defaults to draft; deletes go to the trash; permanent deletion is double-gated.
- Dry-run previews with single-use, argument-bound confirmation tokens.
- SELECT-only SQL with row limits, stacked-statement refusal and a `wp-config.php` opt-in for writes.
- PHP syntax checking before any theme file or snippet is written; snippets land disabled.
- Append-only audit logs, both locally and on the site.

**Companion plugin**
- `wpxmcp-helper` exposing WP-CLI emulation, SQL, theme files and drafts, unregistered meta, options, theme mods, roles, site health, snippets and editable fields.

**Playbooks**
- Eight bundled skills: site setup, Gutenberg, classic themes, page builders, SEO audit, editable fields, design and troubleshooting.
- `save_skill` for your own conventions.
