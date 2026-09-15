=== wpxmcp Helper ===
Contributors: wpxmcp
Tags: mcp, ai, rest-api, wp-cli, developer
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Companion plugin for the wpxmcp MCP server. Adds what core REST cannot reach: WP-CLI, guarded SQL, theme drafts, error logs, profiling, plugin settings and admin screens.

== Description ==

This plugin is the site-side half of [wpxmcp](https://github.com/alokemajumder/wpxmcp), an MCP server that lets AI assistants manage self-hosted WordPress sites.

It is **optional**. Posts, pages, media, taxonomies, users, comments, plugins, menus, widgets, block templates, SEO metadata and link checks all work through core REST without it. This plugin adds the things core REST has no endpoint for:

* **Emulated WP-CLI** — 50+ commands run in PHP. No binary, no SSH, no shell access.
* **Database queries** — read-only by default, inside a read-only transaction, with an enforced row limit.
* **Theme files and drafts** — edit a sandboxed clone, preview it privately, publish when ready.
* **Error log and diagnostics** — the end of the PHP error log with duplicates grouped and attributed to the plugin or theme responsible, plus the last fatal error even when logging is off.
* **Cache purges** — through the API of each installed cache plugin or host cache.
* **Security and backup facts** — configuration checks for a security audit, and when the last backup ran.
* **Request profiling** — queries, template, outbound HTTP calls, PHP warnings and memory for one front-end request, like Query Monitor.
* **Developer introspection** — registered post types, blocks, REST routes, hooks with their source file, cron, autoloaded options and database tables, each attributed to its owner, with a guarded options cleanup.
* **Plugin settings and admin screens** — read and update any plugin's settings through WordPress's own save, with backups, and view or submit its wp-admin screens as the administrator.
* **Unregistered post meta** — the keys `show_in_rest` hides, including page-builder documents.
* **Options, theme mods, roles and Site Health.**
* **Code snippets** — PHP, CSS, JS and HTML without touching theme files.
* **Editable fields** — fourteen field types rendering as native meta boxes and a settings page.

= Security =

Every endpoint requires an authenticated administrator (`manage_options`). On multisite, a network super admin.

* Mutating SQL additionally requires `define( 'WPXMCP_ALLOW_SQL_WRITES', true );` in wp-config.php. Read-only queries run inside a read-only transaction.
* Stacked SQL statements, and statements that read or write server files (INTO OUTFILE, LOAD_FILE, LOAD DATA), are always refused.
* Options that would lock you out of the site or weaken it (siteurl, home, active_plugins, template, stylesheet, cron, default_role, user roles, salts, upload paths) and the plugin's own state are protected on every write path.
* Theme paths are confined to the theme directory, with symlinks resolved and extensions allowlisted.
* Theme file changes, plugin installs and updates honour `DISALLOW_FILE_EDIT` and `DISALLOW_FILE_MODS`.
* Writing to the live active theme is refused unless explicitly overridden.
* PHP is syntax-checked before it is written, so a parse error is reported rather than fataling the site.
* Snippets are always created disabled and can only be activated from wp-admin. Changing an active snippet's code disables it until it is reviewed again.
* A PHP snippet that fatals is disabled automatically. If the site is still down, add `define( 'WPXMCP_SAFE_MODE', true );` to wp-config.php to skip all snippets.
* search-replace refuses a real run unless the same replacement was dry-run first.
* Profiling and wp-admin access use single-use tokens: random, valid for two minutes, stored only as a keyed hash, bound to one URL (and, for wp-admin, one HTTP method), limited to 20 outstanding per user, and never cached. A wp-admin request authenticated this way sends no cookie back and leaves no session behind.
* Plugin settings are written through update_option(), so the plugin's sanitizer runs; the previous five values of each option are kept for restoring, and secret-looking values are masked when read.
* Error-log paths are made relative, and the fatal-error recorder never stores query strings.
* Every sensitive action is recorded in an append-only log.

= Data ownership =

Field values are stored as standard post meta and options. Removing this plugin removes the editing UI, not your content.

== Installation ==

1. Zip the `wpxmcp-helper` folder.
2. In wp-admin, go to Plugins > Add New > Upload Plugin.
3. Choose the zip, install, and activate.
4. Run `test_site` from your MCP client to confirm the `wpxmcp/v1` namespace is available.

== Frequently Asked Questions ==

= Do I need this plugin? =

Only for WP-CLI, SQL, theme file editing, the error log, cache purges, backup status, profiling, developer introspection, plugin settings and admin screens, unregistered meta, options, snippets and editable fields. Everything else works without it.

= Does it slow the site down? =

No. On an ordinary request, profiling and wp-admin access cost a single isset() check each: unless the URL carries a valid token, no profiler collector or admin authentication is ever set up. Draft previews check for their own parameter the same way, and a shutdown handler reads error_get_last() once, writing to the database only after a fatal error. REST routes load only on REST requests, and snippets and fields run only if you have activated or registered them.

= Can an AI publish a theme without my approval? =

Not accidentally. Theme edits go to a draft; publishing is a separate, explicitly confirmed step that backs up the previous theme first.

= Can an AI change a plugin's settings without my approval? =

Not accidentally. Settings writes and form submissions first return a preview and a confirmation token that must be sent back, the previous value is backed up, and the screens that install, delete or edit plugins and themes, create or delete users, export the site or run updates are refused.

== Changelog ==

= 2.0.0 =
* New: error log with grouping and attribution, a fatal-error recorder, cache purges, security and backup facts.
* New: per-request profiling and template resolution through single-use tokens.
* New: registry, options and database introspection, and a guarded options cleanup.
* New: plugin inspection, settings reads and writes with backups, and wp-admin screens and forms through single-use admin tokens.
* Security: every route requires a network super admin on multisite; theme file changes and WP-CLI installs, updates and activations honour DISALLOW_FILE_EDIT, DISALLOW_FILE_MODS and the matching capabilities.
* Security: SQL is inspected with a MySQL-aware lexer, file access (INTO OUTFILE, LOAD_FILE, LOAD DATA) is refused, and read-only queries run in a read-only transaction.
* Security: one protected-option list covers every write path, including editable fields and WP-CLI option delete; search-replace skips the plugin's own options and requires a prior dry run.
* Security: theme paths reject dot segments, null bytes and stream wrappers and resolve symlinks through the nearest existing directory; drafts and backups never copy symlinks; only drafts can be published.
* Security: changing an active snippet's code disables it; fatal errors disable the snippet responsible; WPXMCP_SAFE_MODE skips all snippets.
* Fix: backslashes in meta written through the plugin (Elementor and other JSON documents) are preserved.
* Fix: autoload reports understand WordPress 6.6 autoload values.
* Fix: search-replace preserves corrupt serialised values and reports when more than 5,000 rows matched.
* Fix: publishing a draft carries the live theme's theme mods over; theme files starting with HTML pass the syntax check; binary theme files are returned base64-encoded.
* Fix: HTML snippets are output.

= 1.0.0 =
* First release.
