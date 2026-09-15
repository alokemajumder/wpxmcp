# How wpxmcp compares, and whether you need the plugin

Researched August 2026. Repository facts were checked through the GitHub API rather than taken from summary articles — several "best WordPress MCP server" lists still recommend Automattic's server, which has been archived since August 2025.

## The landscape

Researched August 2026. Facts verified against each project's repository; capability counts are as each project documents them.

| | wpxmcp | [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) | [Automattic wordpress-mcp](https://github.com/Automattic/wordpress-mcp) | [InstaWP mcp-wp](https://github.com/instawp/mcp-wp) | [docdyhr/mcp-wordpress](https://github.com/docdyhr/mcp-wordpress) | WPVibe |
| --- | --- | --- | --- | --- | --- | --- |
| **Licence** | MIT, OSS | GPL, OSS (official) | GPL, OSS | OSS + paid hosted | MIT, OSS | Commercial |
| **Status** | Active | Active | **Archived** | Active | Active | Commercial |
| **Remote MCP** | ✅ Workers, 1-click | ✅ REST endpoint on the site | ❌ | Hosted tier | ❌ stdio only | ✅ hosted |
| **Local stdio** | ✅ | ✅ via WP-CLI | ✅ | ✅ | ✅ | ✅ |
| **Credentials centralised** | ✅ Worker Secrets | On the site itself | Per client | Hosted tier | ❌ per laptop | ✅ vendor-hosted |
| **Multi-site, one server** | ✅ | ❌ one plugin per site | ❌ | Partial | ✅ | ✅ |
| **Requires a plugin** | Optional | **Required** | Required | Optional | ❌ | Required |
| **Minimum WordPress** | 6.0 | Needs the Abilities API (core in 7.0+) | 6.4 | 6.0 | 6.0 | — |
| **Partial/targeted edits** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Theme file editing** | ✅ sandboxed drafts | ❌ | ❌ | ✅ | ❌ | ✅ |
| **WP-CLI** | ✅ 50+, emulated | ❌ | ❌ | ✅ | ❌ | ✅ |
| **SQL** | ✅ guarded | ❌ | ❌ | ✅ | ❌ | ✅ |
| **Dry-run before destruction** | ✅ | n/a | ❌ | ❌ | ❌ | ✅ |
| **Abilities API support** | ✅ as a client | ✅ that *is* the project | ❌ | ❌ | ❌ | ✅ |
| **MCP protocol** | 2026-07-28, plus 2025-era clients on the same endpoint | — | — | — | — | — |
| **Error log and diagnostics** | ✅ grouped, attributed to plugin/theme (plugin) | — | — | — | — | — |
| **Per-request profiling** | ✅ queries, template, HTTP calls, warnings (plugin) | — | — | — | — | — |
| **Security audit** | ✅ outside-in probes + WPVulnerability lookups | — | — | — | — | — |
| **SEO metadata across SEO plugins** | ✅ Yoast, Rank Math, AIOSEO, SEOPress, The SEO Framework | — | — | — | — | — |
| **Fleet report across sites** | ✅ one call, in parallel | — | — | — | — | — |
| **Operate installed plugins' settings and admin screens** | ✅ previewed, backed up (plugin) | — | — | — | — | — |
| **Tools** | 150 | Whatever registers abilities | ~20 | 43 | ~40 | — |
| **Cost** | Free | Free | Free | Free / paid | Free | Paid |

— in the rows added for 2.0.0 means not verified for that project, not that it is missing. "(plugin)" marks capabilities that need the wpxmcp companion plugin.

## What this means in practice

**[WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) is the official direction, and wpxmcp is complementary rather than competing.** It bridges the [Abilities API](https://github.com/WordPress/abilities-api) to MCP, turning a site into an MCP server at `/wp-json/mcp/mcp-adapter-default-server`. It is excellent for *plugin-defined* capabilities — but it can only expose abilities that something registered, and abilities are private unless explicitly published. Core itself registers just three, all read-only. It is also one endpoint per site, so managing several sites means several connections and several plugin installs.

wpxmcp works against **any WordPress 6.0+ site today**, manages many sites through one connection, and **acts as an Abilities API client** — `discover_abilities` and `run_ability` call `/wp-abilities/v1/…` directly, which is in core from WordPress 7.0 and needs no adapter. Where a plugin exposes an ability, using it is the *right* answer, because the plugin's own validation, hooks and cache invalidation run. wpxmcp prefers abilities and falls back to REST, WP-CLI, then guarded SQL, in that order.

**[Automattic's wordpress-mcp](https://github.com/Automattic/wordpress-mcp) is archived** (944 stars, last pushed August 2025). Its own repository description directs you to the MCP Adapter. Several "best WordPress MCP servers" lists still recommend it; they are out of date.

**The stdio-only servers** ([docdyhr](https://github.com/docdyhr/mcp-wordpress), and a long tail of smaller projects) are fine for one developer and one site. They hit the credential-sprawl problem the moment a second person is involved, and none of them offer dry-runs, sandboxed theme edits, or partial content edits.

**Commercial hosted services** (WPVibe and similar) solve credential centralisation well and are genuinely polished. The trade-offs are the usual ones: a subscription, your site credentials held by a third party, and no ability to read or modify the server. wpxmcp is MIT-licensed and deploys to *your* Cloudflare account, so the credentials and the code stay yours.

**Choose something else if:** you only need plugin-registered abilities on WP 6.9+ (use the MCP Adapter), you manage one site from one laptop and want the smallest thing that works (use a stdio server), or you want a supported product with a vendor to call (use a commercial service).

---

## Is it a remote MCP server, or a plugin?

**It is a remote MCP server.** wpxmcp runs on Cloudflare Workers (or locally over stdio) and talks to WordPress over its public REST API. Your sites need nothing installed for **113 of the 150 tools**.

The remaining 37 exist because **WordPress itself provides no API for them** — not because of a design shortcut here. That claim is worth checking rather than taking on trust, so here is the evidence:

| Capability | What core WordPress offers | Verified against |
| --- | --- | --- |
| Activate / install a theme | `/wp/v2/themes` is **GET-only**. Every schema field is read-only; there is no POST, PUT or DELETE route. | [REST API Handbook: Themes](https://developer.wordpress.org/rest-api/reference/themes/) |
| Read / write theme files | No route at all. The theme file editor is an admin screen, never an API. | REST API Handbook |
| Run WP-CLI | No route. WP-CLI is a separate binary that expects shell access. | — |
| Run SQL | No route, by design. | — |
| Meta without `show_in_rest` | Core **silently discards** it. This is most page-builder and ACF data. | `register_post_meta` semantics |
| Options, theme mods, Site Health | `/wp/v2/settings` exposes only settings registered with `show_in_rest`; arbitrary options, theme mods and the Site Health *direct* tests are not exposed. Core does expose the async Site Health tests at `wp-site-health/v1`, which wpxmcp uses without the plugin. | REST API Handbook |
| PHP error log | No route. The log is a file on the server's disk (and should never be publicly downloadable). | — |
| Per-request profiling (queries, hooks, template) | No route. Query timing needs `SAVEQUERIES` and hooks inside the request being measured. | — |
| Page-cache purges | Core has no page cache and no purge API; each cache plugin or host exposes its own PHP functions. | — |
| Registered hooks, cron, shortcodes, option weight | No route for hooks, shortcodes or autoload sizes. | — |
| Plugin settings screens and admin forms | wp-admin pages are server-rendered screens, not REST resources; many plugins keep settings only there. | — |

**Could the Abilities API replace it?** No — and this is checked against a live install, not the documentation. The Abilities API **is now in WordPress core** (verified on 7.1: `wp-includes/abilities-api/`, serving `wp-abilities/v1`). But core registers **exactly three abilities**, all read-only: `core/get-site-info`, `core/get-user-info` and `core/get-environment-info`. None touches WP-CLI, SQL, theme files or arbitrary meta. It is an excellent way to reach *plugin-registered* capabilities — which is why wpxmcp is a client of it — and no substitute for the routes core simply does not have.

**Every WordPress MCP tool that offers these capabilities ships site-side code**, including the official [MCP Adapter](https://github.com/WordPress/mcp-adapter), which is itself a plugin and is *mandatory* rather than optional. This is a platform boundary, not a differentiator.

## Do you need WordPress/mcp-adapter installed?

**No.** It is an alternative to wpxmcp, not a dependency of it. The adapter turns a WordPress site *into* an MCP server that clients connect to directly; wpxmcp *is* the MCP server and reaches WordPress over its REST API. You would install the adapter if you preferred that architecture — you never need it to run wpxmcp.

The one place they meet is the Abilities API, which wpxmcp calls directly at `wp-abilities/v1` and which is **built into WordPress core**, not provided by the adapter. `discover_abilities`, `get_ability_info` and `run_ability` work on a stock WordPress 7.x with nothing installed; on older versions they report that the API is absent and suggest alternatives. Installing the adapter alongside wpxmcp changes nothing about how wpxmcp behaves.

## Where wpxmcp differs: the plugin is optional and additive

Install it only if you want what is in that table. Nothing degrades if you do not, and every tool that needs it says so by name and tells you how to install it — rather than failing with a confusing 404.

**Works against a stock WordPress install, nothing added (113 tools):**
posts · pages · every custom post type · categories · tags · custom taxonomies · media and uploads · users · comments · plugin install/activate/delete · theme listing and WordPress.org theme search · menus and menu items · widgets and sidebars · block templates · global styles and style variations · Site Editor diffs and template resets · theme.json validation · accessibility checks · reusable blocks and patterns · site settings · revisions · rendered page HTML · search · SEO metadata · site-wide SEO checks · link checks and internal-link reports · content inventory and calendar · fleet report · the outside-in half of the security audit · the raw `rest_api` escape hatch · the Abilities API client

**Needs the [companion plugin](../wp-plugin/wpxmcp-helper) (37 tools):**
WP-CLI · SQL · theme files and the draft/preview/publish workflow · theme activation and installation · options · Site Health and database size · code snippets · editable fields · the PHP error log · cache purges · backup status · request profiling and template resolution · registry, options and database introspection · options cleanup · inspecting installed plugins, their settings and their wp-admin screens

Eleven further tools (marked ➕ in the [tool reference](TOOLS.md)) work either way and return more when the plugin is present — `site_info`, `get_content_meta`, `security_audit` and `seo_site_check` among them — saying which parts they could not see.

## Which to run

| You want | Run |
| --- | --- |
| Content, media, taxonomies, users, comments, menus, widgets — the everyday work | **The MCP server alone.** Nothing on the site. |
| Theme building, WP-CLI, SQL, page-builder meta, editable fields | **MCP server + companion plugin.** |
| Diagnosing errors and slow pages, purging caches, operating a plugin's settings screens | **MCP server + companion plugin.** |
| Only plugin-registered abilities on WordPress 6.9+ | Consider the official [MCP Adapter](https://github.com/WordPress/mcp-adapter) instead — and note wpxmcp can call those abilities too. |

The plugin adds REST routes under `wpxmcp/v1`, every one of them requiring an authenticated administrator. Full detail: [docs/COMPANION_PLUGIN.md](COMPANION_PLUGIN.md).

---

