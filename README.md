# wpxmcp

**A remote-first MCP server for self-hosted WordPress.** Manage content, design, themes, plugins, menus, widgets, users and the database from any MCP client — with your WordPress credentials in Cloudflare Worker Secrets instead of on every laptop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpxmcp/wpxmcp)
[![CI](https://github.com/wpxmcp/wpxmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wpxmcp/wpxmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-black.svg)](https://modelcontextprotocol.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**117 tools · 2 transports · 0 required plugins · MIT**

> Self-hosted WordPress only. WordPress.com does not expose the REST endpoints or filesystem this depends on.

---

## What it feels like to use

> **"Find the pricing page, change the Pro tier to $49, and check it actually shows."**

```
find_content_by_url  https://example.com/pricing/
  → resolved by "slug lookup in \"page\"" — id 812, type page, 1,240 words

update_content  id 812, edits: [{ find: "<strong>$39</strong>", replace: "<strong>$49</strong>" }]
  → updated. 1 replacement. Body length 8,431 → 8,431 characters.

get_page_html  /pricing/  mode: "summary"
  → title "Pricing — Example", h1_count 1, images_missing_alt 0
  → still shows $39
```

The page cache is stale, not the write. One `run_wp_cli cache flush` later it is correct — and you found that out because the tool read the *rendered page*, not because the API said `200`.

> **"Audit the blog for SEO problems."**

```
audit_content  type: "post", limit: 200
  → examined 200, items_with_issues 47, clean_items 153
  → issue_summary:
       "no SEO meta description"                          31
       "no featured image"                                22
       "N of N inline images have no alt text"            18
       "thin content (N words, threshold N)"               9
       "title is N characters — search results usually…"   6
  → findings: [{ id, title, link, word_count, issues: [...] }, ...]
```

Then fix them in bulk — and see exactly what would change before anything is written:

```
bulk_update_content  type: "post", filter: { categories: [12] }, changes: { status: "draft" }
  → applied: false, dry_run: true
  → would_update 14, would_skip 3
  → plan: [{ id: 902, title: "…", current_status: "publish", would_change: ["status"] }, …]
  → confirm_token: "confirm-3f9a1c4b7e02d85c61"
```

Nothing was written. Re-run with that token and it applies — change any argument and the token stops matching.

---

## The problems this actually solves

Plenty of things can create a WordPress post from an AI client. The hard parts are elsewhere.

### 1. Credential sprawl

Most WordPress MCP servers run over **stdio**, on your machine. That means every person × every site needs its own Application Password sitting in a config file on a laptop. Ten sites and five people is fifty credentials with no central revocation, no shared audit trail, and no answer to "which laptop still has access?"

wpxmcp runs as a **remote MCP server on Cloudflare Workers**. WordPress credentials live in [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) — one place, encrypted at rest, not readable back. Clients hold only a bearer token for your Worker, which you rotate with one command. The same build also runs locally over stdio when that is what you want.

### 2. Agents that delete things

An agent with write access to production will eventually be confidently wrong. Most servers pass a delete straight through.

Here, content deletes go to the trash; permanent deletion needs `force` **and** `confirm` and first shows you what would be destroyed. Bulk edits, `search-replace` and mutating SQL **dry-run first** and return a single-use token fingerprinted against those exact arguments — change one argument and the token stops matching. New posts default to **draft**. Theme edits happen in a sandboxed clone. Twelve more guardrails are listed in [SECURITY.md](SECURITY.md).

### 3. Rewriting a whole page to change one line

The usual `update_post(content)` shape means re-sending a 3,000-word document to fix a price — slow, expensive, and every regeneration is a chance to lose something.

`update_content` takes `edits: [{find, replace}]`. It changes exactly that string. **An edit that matches nothing fails loudly** rather than silently writing nothing, which is the failure mode that quietly destroys content.

### 4. Page builders that silently discard your writes

Elementor, Divi, Beaver Builder, Bricks and Breakdance do **not** store layouts in `post_content` — they store a structured document in post meta and regenerate `post_content` from it. Write to `post_content` and the change either does nothing or is overwritten on the builder's next save. Tools that expose a generic "update post" happily let an agent do this.

wpxmcp detects builder-owned content and says so, and ships a [page-builders playbook](skills/page-builders.md) the agent loads before touching such a post.

### 5. "The API returned 200" is not "the site changed"

A page cache, an object cache or Cloudflare in front of the site means a successful write can be invisible to visitors for hours. `get_page_html` fetches **what a visitor actually receives**, so a change can be verified rather than assumed.

### 6. Everything the REST API cannot reach

Core REST has no endpoint for running WP-CLI, reading a theme file, or writing a meta key registered without `show_in_rest` — which is most page-builder and ACF data. An optional companion plugin adds exactly those, and nothing else.

### 7. Sites that stay editable by humans

A theme only an agent can change is a liability. `register_fields` wires up custom fields that render as **native meta boxes in wp-admin**, stored as ordinary post meta, so the client can keep editing after the agent is gone.

---

## How it compares

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
| **Works on WP < 6.9** | ✅ | ❌ needs Abilities API | ✅ | ✅ | ✅ | ✅ |
| **Partial/targeted edits** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Theme file editing** | ✅ sandboxed drafts | ❌ | ❌ | ✅ | ❌ | ✅ |
| **WP-CLI** | ✅ 50+, emulated | ❌ | ❌ | ✅ | ❌ | ✅ |
| **SQL** | ✅ guarded | ❌ | ❌ | ✅ | ❌ | ✅ |
| **Dry-run before destruction** | ✅ | n/a | ❌ | ❌ | ❌ | ✅ |
| **Abilities API support** | ✅ as a client | ✅ that *is* the project | ❌ | ❌ | ❌ | ✅ |
| **Tools** | 117 | Whatever registers abilities | ~20 | 43 | ~40 | — |
| **Cost** | Free | Free | Free | Free / paid | Free | Paid |

### What this means in practice

**[WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) is the official direction, and wpxmcp is complementary rather than competing.** It bridges the [Abilities API](https://github.com/WordPress/abilities-api) to MCP, turning a site into an MCP server at `/wp-json/mcp/mcp-adapter-default-server`. It is excellent for *plugin-defined* capabilities — but it can only expose abilities that something registered, abilities are private unless explicitly published, and the Abilities API ships as a feature plugin proposed for core rather than something already on every site. It is also one endpoint per site, so multi-site management means multiple connections.

wpxmcp works against **any WordPress 6.0+ site today**, manages many sites through one connection, and **acts as an Abilities API client** — `discover_abilities` and `run_ability` call `/wp-abilities/v1/…` directly. Where a plugin exposes an ability, using it is the *right* answer, because the plugin's own validation, hooks and cache invalidation run. wpxmcp prefers abilities and falls back to REST, WP-CLI, then guarded SQL, in that order.

**[Automattic's wordpress-mcp](https://github.com/Automattic/wordpress-mcp) is archived** (944 stars, last pushed August 2025). Its own repository description directs you to the MCP Adapter. Several "best WordPress MCP servers" lists still recommend it; they are out of date.

**The stdio-only servers** ([docdyhr](https://github.com/docdyhr/mcp-wordpress), and a long tail of smaller projects) are fine for one developer and one site. They hit the credential-sprawl problem the moment a second person is involved, and none of them offer dry-runs, sandboxed theme edits, or partial content edits.

**Commercial hosted services** (WPVibe and similar) solve credential centralisation well and are genuinely polished. The trade-offs are the usual ones: a subscription, your site credentials held by a third party, and no ability to read or modify the server. wpxmcp is MIT-licensed and deploys to *your* Cloudflare account, so the credentials and the code stay yours.

**Choose something else if:** you only need plugin-registered abilities on WP 6.9+ (use the MCP Adapter), you manage one site from one laptop and want the smallest thing that works (use a stdio server), or you want a supported product with a vendor to call (use a commercial service).

---

## Is it a remote MCP server, or a plugin?

**It is a remote MCP server.** wpxmcp runs on Cloudflare Workers (or locally over stdio) and talks to WordPress over its public REST API. Your sites need nothing installed for **93 of the 117 tools**.

The remaining 24 exist because **WordPress itself provides no API for them** — not because of a design shortcut here. That claim is worth checking rather than taking on trust, so here is the evidence:

| Capability | What core WordPress offers | Verified against |
| --- | --- | --- |
| Activate / install a theme | `/wp/v2/themes` is **GET-only**. Every schema field is read-only; there is no POST, PUT or DELETE route. | [REST API Handbook: Themes](https://developer.wordpress.org/rest-api/reference/themes/) |
| Read / write theme files | No route at all. The theme file editor is an admin screen, never an API. | REST API Handbook |
| Run WP-CLI | No route. WP-CLI is a separate binary that expects shell access. | — |
| Run SQL | No route, by design. | — |
| Meta without `show_in_rest` | Core **silently discards** it. This is most page-builder and ACF data. | `register_post_meta` semantics |
| Options, theme mods, Site Health | Not exposed over REST. | REST API Handbook |

**Could the Abilities API replace it?** Not today. The [Abilities API](https://github.com/WordPress/abilities-api) ships [exactly three core abilities](https://github.com/WordPress/abilities-api/blob/trunk/includes/abilities/wp-core-abilities.php) — `core/get-site-info`, `core/get-user-info` and `core/get-environment-info` — all read-only, and none covering WP-CLI, SQL, theme files or arbitrary meta. It is also still a feature plugin proposed for core, so it is not yet on the sites you already manage.

**Every WordPress MCP tool that offers these capabilities ships site-side code**, including the official [MCP Adapter](https://github.com/WordPress/mcp-adapter), which is itself a plugin and is *mandatory* rather than optional. This is a platform boundary, not a differentiator.

### Where wpxmcp differs: the plugin is optional and additive

Install it only if you want what is in that table. Nothing degrades if you do not, and every tool that needs it says so by name and tells you how to install it — rather than failing with a confusing 404.

**Works against a stock WordPress install, nothing added (93 tools):**
posts · pages · every custom post type · categories · tags · custom taxonomies · media and uploads · users · comments · plugin install/activate/delete · theme listing · menus and menu items · widgets and sidebars · block templates · global styles · reusable blocks · site settings · revisions · rendered page HTML · search · the raw `rest_api` escape hatch · the Abilities API client

**Needs the [companion plugin](wp-plugin/wpxmcp-helper) (24 tools):**
WP-CLI · SQL · theme files and the draft/preview/publish workflow · theme activation and installation · unregistered post meta · options · theme mods · Site Health and database size · code snippets · editable fields

Four further tools (`site_info`, `get_content_meta`, `list_roles`, `discover_abilities`) work either way and simply return more when the plugin is present, saying which parts they could not see.

### Which to run

| You want | Run |
| --- | --- |
| Content, media, taxonomies, users, comments, menus, widgets — the everyday work | **The MCP server alone.** Nothing on the site. |
| Theme building, WP-CLI, SQL, page-builder meta, editable fields | **MCP server + companion plugin.** |
| Only plugin-registered abilities on WordPress 6.9+ | Consider the official [MCP Adapter](https://github.com/WordPress/mcp-adapter) instead — and note wpxmcp can call those abilities too. |

The plugin adds REST routes under `wpxmcp/v1`, every one of them requiring an authenticated administrator. Full detail: [docs/COMPANION_PLUGIN.md](docs/COMPANION_PLUGIN.md).

---

## Deploy as a remote MCP server (recommended)

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpxmcp/wpxmcp)

Cloudflare forks the repository to your account, provisions the Worker, sets up CI/CD, and **prompts you for the two secrets** (`WPX_AUTH_TOKEN` and `WPX_SITES`) as part of the flow.

### Or three commands

```bash
npm install
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
npx wrangler secret put WPX_SITES     # paste your sites JSON, then Ctrl-D
npm run deploy
```

Then connect any client:

```jsonc
{
  "mcpServers": {
    "wpxmcp": {
      "type": "http",
      "url": "https://wpxmcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your WPX_AUTH_TOKEN>" }
    }
  }
}
```

Free tier covers 100,000 requests a day, and a stateless server holds nothing open between them.

**Full walkthrough — secrets, custom domains, KV audit storage, rotation, troubleshooting: [docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md).**

---

## Or run it locally over stdio

```bash
git clone https://github.com/wpxmcp/wpxmcp.git
cd wpxmcp && npm install && npm run build
```

Create an Application Password: **wp-admin → Users → Profile → Application Passwords**.

```bash
claude mcp add wpxmcp -- node /absolute/path/to/wpxmcp/dist/index.js \
  -e WORDPRESS_URL=https://example.com \
  -e WORDPRESS_USERNAME=admin \
  -e "WORDPRESS_APP_PASSWORD=abcd EFGH ijkl MNOP qrst UVWX"
```

Or as JSON, for Claude Desktop, Cursor and others:

```jsonc
{
  "mcpServers": {
    "wpxmcp": {
      "command": "node",
      "args": ["/absolute/path/to/wpxmcp/dist/index.js"],
      "env": {
        "WORDPRESS_URL": "https://example.com",
        "WORDPRESS_USERNAME": "admin",
        "WORDPRESS_APP_PASSWORD": "abcd EFGH ijkl MNOP qrst UVWX"
      }
    }
  }
}
```

Verify before wiring anything up:

```bash
npm run doctor
```

It checks reachability, authentication, the user's capabilities and plugin presence — naming the specific misconfiguration rather than failing generically.

**Local-only differences:** `create_media` can read a file path from your disk, and `save_skill` can write playbooks. Both are inherent to having a filesystem; the affected tools say so plainly when called remotely. Everything else is identical, because both entry points build from the same `src/toolset.ts`.

---

## Authentication

wpxmcp uses **Application Passwords**, built into WordPress core since 5.6 — a revocable per-integration credential, separate from the account's real password, that works with 2FA enabled.

Two things are worth knowing before you start:

1. **WordPress only offers Application Passwords over HTTPS** (or in a local environment). On a plain-HTTP production site the section does not appear at all.
2. **Some hosts strip the `Authorization` header**, producing a 401 with credentials that are entirely correct. This is the single most common setup failure; `test_site` detects it and gives you the one-line fix.

Give the account the **least-privileged role that does the job** — Editor is enough for all content and media work; Administrator is only needed for settings, plugins, themes, WP-CLI and SQL.

**Full detail — role table, HTTPS filter, header passthrough for Apache/Nginx/LiteSpeed, security plugins, rotation and revocation: [docs/WORDPRESS_AUTH.md](docs/WORDPRESS_AUTH.md).**

---

## Managing several sites

```json
{
  "sites": [
    { "id": "blog", "url": "https://blog.example.com", "username": "admin", "appPassword": "..." },
    { "id": "shop", "url": "https://shop.example.com", "username": "admin", "appPassword": "..." },
    { "id": "prod", "url": "https://example.com",      "username": "admin", "appPassword": "...", "writable": false }
  ]
}
```

That JSON is the `WPX_SITES` secret remotely, or `~/.wpxmcp/sites.json` locally. Then:

> "Publish the pricing draft on **shop**, then check it renders."

`"writable": false` refuses every write at the server, so an agent cannot touch production while you experiment elsewhere. Every option: [sites.example.json](sites.example.json), [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## What it can do

117 tools. Full reference in **[docs/TOOLS.md](docs/TOOLS.md)**.

| Area | Tools |
| --- | --- |
| **Multi-site** | List, inspect and diagnose every configured site; read the audit log |
| **Content** | Nine tools for posts, pages and any CPT — with targeted edits and URL resolution |
| **Taxonomies** | Eight tools for categories, tags and any custom taxonomy |
| **Media** | Upload from disk, URL or base64; stock photo search; alt-text auditing |
| **Design & themes** | Sandboxed drafts, classic PHP + Tailwind scaffolding, private previews, backed-up publishes |
| **Appearance** | Menus, widgets, sidebars, block templates, global styles, Customizer |
| **Users & comments** | Full CRUD, roles, bulk moderation |
| **Plugins** | Install, activate, update, delete; search WordPress.org |
| **Site intelligence** | Versions, health, database size, updates, rendered page HTML |
| **Power tools** | WP-CLI, guarded SQL, Abilities API, snippets, editable fields, raw REST |
| **Bulk & audit** | Dry-run bulk edits, content and media audits |
| **Playbooks** | Eight built-in skills the agent loads before it works |

---

## Architecture

```
                       ┌─────────────────────────────────────────┐
   MCP client          │  Cloudflare Worker (your account)       │
   Claude / Cursor ───►│                                         │
   ChatGPT / …         │  Authorization: Bearer <WPX_AUTH_TOKEN> │
        │              │                                         │
        │              │  Worker Secrets ── WPX_SITES            │
   one bearer token    │    (WordPress Application Passwords)    │
   per person          └──────────────────┬──────────────────────┘
                                          │  Basic auth over HTTPS
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                    blog.example    shop.example    example.com
                       WP REST         WP REST         WP REST
                          └── + optional wpxmcp-helper plugin ──┘
                              (WP-CLI, SQL, theme files, meta)
```

**Stateless.** Each request builds a fresh server and tears it down — no Durable Object, no session affinity, no connection held open. That is why it fits in Cloudflare's free tier and why an isolate can be evicted between calls without anything breaking.

**One toolset, two transports.** `src/index.ts` (stdio) and `src/worker.ts` (HTTP) both build from `src/toolset.ts`, so the two deployments cannot drift apart. A `platform()` abstraction keeps `src/lib` and `src/tools` free of Node APIs; CI fails if `node:fs`, `process` or `Buffer` appear there.

---

## Why you might fork this

It is MIT, and the parts worth stealing are separable:

- **`src/lib/http-transport.ts`** — a stateless MCP Streamable HTTP transport in ~180 lines, no Durable Objects and no Cloudflare-specific SDK. Drop it into any Worker or any `fetch`-based runtime to make an MCP server remote.
- **`src/lib/safety.ts`** — the dry-run/confirm-token pattern, the SQL guard and the default-deny command allowlist. Reusable by any agent tool that can destroy something.
- **`src/lib/content-utils.ts`** — targeted find/replace edits with loud failures, and WordPress URL→object resolution.
- **`src/lib/theme-scaffold.ts`** — a complete classic PHP + Tailwind theme generator with tokenised design.
- **`wp-plugin/wpxmcp-helper/`** — ~4,300 lines of PHP doing WP-CLI emulation, guarded SQL and a sandboxed theme-draft workflow, none of which core REST offers.
- **`skills/`** — eight agent playbooks, notably the page-builder one, which encodes knowledge that is genuinely hard-won.

Adding a tool is one `defineTool({...})`. It appears on both transports automatically.

---

## Project status

**v1.0.0.** 48 tests, CI across Node 20/22/24 and PHP 7.4/8.3, both entry points built and the Worker deploy dry-run verified on every push.

Honest about what has and has not been exercised: the TypeScript server, both transports and all guardrails are tested and were run end to end. The companion plugin lints clean on PHP 8.5 and follows WordPress APIs throughout, but has not yet been run against a live WordPress install — if you try it, [an issue](https://github.com/wpxmcp/wpxmcp/issues) with what you find is the single most useful contribution right now.

Also welcome: more playbooks (WooCommerce, ACF, multisite), page-builder write paths that go through each builder's own save routine, and additional WP-CLI commands for the allowlist.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md) | Remote deployment, secrets, custom domains, rotation, troubleshooting |
| [docs/WORDPRESS_AUTH.md](docs/WORDPRESS_AUTH.md) | Application Passwords, roles, HTTPS, header passthrough, security plugins |
| [docs/TOOLS.md](docs/TOOLS.md) | Every tool, grouped, with what it is for |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every option and precedence rule |
| [docs/COMPANION_PLUGIN.md](docs/COMPANION_PLUGIN.md) | What the plugin adds and how to install it |
| [SECURITY.md](SECURITY.md) | Threat model, guardrails, reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, adding a tool, conventions |

---

## Development

```bash
npm install
npm run build       # bundle playbooks, then compile
npm test            # 48 tests, no network or WordPress site required
npm run typecheck
npm run cf:dev      # the Worker locally at http://localhost:8787/mcp
```

Adding a tool is one `defineTool({...})` in the right `src/tools/*.ts` — it is then available over **both** transports automatically. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Requirements

- **WordPress 6.0+**, self-hosted, REST API reachable over HTTPS
- **An Application Password** for a user with the capabilities you need
- **Node.js 20+** for local use, or a Cloudflare account for remote
- **PHP 7.4+** only if you install the companion plugin

---

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the conventions, and what makes a good tool description. If wpxmcp is useful to you, a star helps other people find it.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by the WordPress Foundation, Automattic, or Cloudflare. "WordPress" is a trademark of the WordPress Foundation.
