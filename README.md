# wpxmcp

**A remote-first MCP server for self-hosted WordPress.** Manage content, design, themes, plugins, menus, widgets, users and the database from any MCP client — with WordPress credentials held in Cloudflare Worker Secrets rather than on every laptop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpxmcp/wpxmcp)
[![CI](https://github.com/wpxmcp/wpxmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/wpxmcp/wpxmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-black.svg)](https://modelcontextprotocol.io)

> Self-hosted WordPress only. WordPress.com does not expose the REST endpoints or filesystem this depends on.

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

## Do you need the WordPress plugin?

**Usually not.** wpxmcp is a remote MCP server that talks to WordPress over its REST API. Nothing needs to be installed on the site for the great majority of it.

**Works with no plugin — 93 of 117 tools:** posts, pages, every custom post type, categories, tags, custom taxonomies, media and uploads, users, comments, plugin install/activate/delete, themes list/activate, menus and menu items, widgets and sidebars, block templates, global styles, reusable blocks, site settings, revisions, rendered page HTML, search, and the raw `rest_api` escape hatch.

**Needs the [companion plugin](wp-plugin/wpxmcp-helper) — 24 tools**, because core WordPress registers **no REST route** for them at all:

| Capability | Why REST cannot do it |
| --- | --- |
| WP-CLI commands | No REST equivalent exists |
| SQL queries | No REST equivalent exists |
| Theme file read/write, drafts, preview, publish | The theme editor is an admin-only screen, not an API |
| Meta keys without `show_in_rest` | Core REST silently discards them — this is most page-builder and ACF data |
| Options and theme mods | Not exposed |
| Site Health, PHP version, database size | Not exposed |
| Code snippets and editable fields | Features this plugin provides |

Four of the 93 (`site_info`, `get_content_meta`, `list_roles`, `discover_abilities`) work without the plugin but return more when it is present, and say which parts they could not see.

This is a genuine platform limitation, not a design choice — every WordPress MCP server that offers WP-CLI or theme editing ships site-side code, and the official MCP Adapter is itself a plugin. wpxmcp differs in making it **optional**: install it only if you need what is in that table, and every tool that requires it says so and tells you how to install it.

The plugin adds REST routes under `wpxmcp/v1`, all requiring an authenticated administrator. See [docs/COMPANION_PLUGIN.md](docs/COMPANION_PLUGIN.md).

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

## License

MIT — see [LICENSE](LICENSE). Not affiliated with or endorsed by the WordPress Foundation, Automattic, or Cloudflare.
