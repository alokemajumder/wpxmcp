=== wpxmcp Helper ===
Contributors: wpxmcp
Tags: mcp, ai, rest-api, wp-cli, developer
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Companion plugin for the wpxmcp MCP server. Exposes the capabilities core REST does not: emulated WP-CLI, guarded SQL, theme drafts, and editable fields.

== Description ==

This plugin is the site-side half of [wpxmcp](https://github.com/wpxmcp/wpxmcp), an MCP server that lets AI assistants manage self-hosted WordPress sites.

It is **optional**. Posts, pages, media, taxonomies, users, comments, plugins, menus, widgets and block templates all work through core REST without it. This plugin adds the things core REST has no endpoint for:

* **Emulated WP-CLI** — 50+ commands run in PHP. No binary, no SSH, no shell access.
* **Database queries** — read-only by default, with keyword blocking and an enforced row limit.
* **Theme files and drafts** — edit a sandboxed clone, preview it privately, publish when ready.
* **Unregistered post meta** — the keys `show_in_rest` hides, including page-builder documents.
* **Options, theme mods, roles and Site Health.**
* **Code snippets** — PHP, CSS and JS without touching theme files.
* **Editable fields** — thirteen field types rendering as native meta boxes and a settings page.

= Security =

Every endpoint requires an authenticated administrator (`manage_options`).

* Mutating SQL additionally requires `define( 'WPXMCP_ALLOW_SQL_WRITES', true );` in wp-config.php.
* Stacked SQL statements are always refused.
* Options that would lock you out of the site (siteurl, home, active_plugins, template, stylesheet) are protected.
* Theme paths are confined to the theme directory, with symlinks resolved and extensions allowlisted.
* Writing to the live active theme is refused unless explicitly overridden.
* PHP is syntax-checked before it is written, so a parse error is reported rather than fataling the site.
* Snippets are always created disabled and can only be activated from wp-admin.
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

Only for WP-CLI, SQL, theme file editing, unregistered meta, options, theme mods, site health, snippets and editable fields. Everything else works without it.

= Does it slow the site down? =

No. It registers REST routes and, where you have used them, meta boxes and field registrations. Nothing runs on a normal front-end request unless you have activated a snippet.

= Can an AI publish a theme without my approval? =

Not accidentally. Theme edits go to a draft; publishing is a separate, explicitly confirmed step that backs up the previous theme first.

== Changelog ==

= 1.0.0 =
* First release.
