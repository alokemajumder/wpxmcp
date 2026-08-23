# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
