# wpxmcp

**A remote-first MCP server for self-hosted WordPress.** Manage content, design, themes, plugins, menus, users and the database from any MCP client — with your WordPress credentials in Cloudflare Worker Secrets instead of on every laptop.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alokemajumder/wpxmcp)
[![CI](https://github.com/alokemajumder/wpxmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alokemajumder/wpxmcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-black.svg)](https://modelcontextprotocol.io)

**117 tools · 2 transports · 0 required plugins · MIT**

> Self-hosted WordPress 6.0+. WordPress.com does not expose the REST endpoints this depends on.

---

## What it looks like

> *"Find the pricing page, change the Pro tier to $49, and check it actually shows."*

```
find_content_by_url  https://example.com/pricing/
  → id 812, type page — resolved by slug lookup in "page"

update_content  id 812, edits: [{ find: "<strong>$39</strong>", replace: "<strong>$49</strong>" }]
  → updated. 1 replacement. 8,431 characters, unchanged in length.

get_page_html  /pricing/  mode: "summary"
  → still shows $39
```

The page cache was stale, not the write — found because the tool read the *rendered page* rather than trusting a `200`.

---

## Why this one

**Credentials in one place.** Most WordPress MCP servers run over stdio, so every person × every site means another Application Password sitting on a laptop. This deploys to Cloudflare Workers with credentials in [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/); clients hold only a bearer token you can rotate with one command. It also runs locally over stdio when that suits.

**Guardrails that actually hold.** New posts default to draft. Deletes go to the trash. Bulk edits, SQL and `search-replace` dry-run first and return a single-use token bound to those exact arguments. Theme edits happen in a sandboxed clone. [All of them](SECURITY.md) — and each was verified to refuse, not just to exist.

**Edits, not rewrites.** `update_content` takes `edits: [{find, replace}]`, so fixing a price doesn't mean re-sending a 3,000-word page. An edit matching nothing **fails loudly** rather than silently writing nothing.

**It knows about page builders.** Elementor, Divi, Beaver Builder, Bricks and Breakdance store layouts in post meta, not `post_content` — write to the wrong place and the change vanishes. wpxmcp detects builder-owned content and ships a [playbook](skills/page-builders.md) the agent reads first.

**Everything REST can't reach.** WP-CLI, SQL, theme files and unregistered meta have no core REST route. An optional companion plugin adds exactly those.

---

## Deploy remotely (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alokemajumder/wpxmcp)

Or three commands:

```bash
npm install
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
npx wrangler secret put WPX_SITES     # your sites JSON, then Ctrl-D
npm run deploy
```

Connect any client:

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

Free tier covers 100,000 requests a day. **[Full walkthrough →](docs/DEPLOY_CLOUDFLARE.md)**

## Or run it locally

```bash
git clone https://github.com/alokemajumder/wpxmcp.git
cd wpxmcp && npm install && npm run build
npm run doctor          # checks reachability, auth, capabilities, plugin
```

```bash
claude mcp add wpxmcp -- node /absolute/path/to/wpxmcp/dist/index.js \
  -e WORDPRESS_URL=https://example.com \
  -e WORDPRESS_USERNAME=admin \
  -e "WORDPRESS_APP_PASSWORD=abcd EFGH ijkl MNOP qrst UVWX"
```

Get the Application Password from **Users → Profile → Application Passwords**. Two gotchas worth knowing: WordPress only offers them over **HTTPS**, and some hosts **strip the `Authorization` header**, causing a 401 with perfectly correct credentials. `test_site` detects both. **[Auth guide →](docs/WORDPRESS_AUTH.md)**

Local-only extras: `create_media` can read a path from your disk, and `save_skill` can write playbooks. Everything else is identical — both transports build from the same toolset.

---

## Do you need the WordPress plugin?

**Not for most work.** 93 of the 117 tools run against a stock WordPress with nothing installed.

The other 24 cover things core WordPress has **no REST route for at all** — WP-CLI, SQL, theme files, and meta registered without `show_in_rest` (which is most page-builder and ACF data). `/wp/v2/themes` is read-only even in WordPress 7.1, so theme activation needs site-side code too.

Every WordPress MCP tool offering these ships site-side code, the official [MCP Adapter](https://github.com/WordPress/mcp-adapter) included — the difference is that ours is optional, and each tool that needs it says so by name.

**You do not need `WordPress/mcp-adapter`.** It is an alternative architecture, not a dependency. The Abilities API it bridges is in WordPress core, and wpxmcp calls it directly.

**[Full comparison and evidence →](docs/COMPARISON.md)** · **[Plugin details →](docs/COMPANION_PLUGIN.md)**

---

## What it can do

| Area | |
| --- | --- |
| **Content** (9) | Posts, pages, any CPT — targeted edits, URL resolution, summaries |
| **Taxonomies** (8) | Categories, tags, custom taxonomies; assign by name |
| **Media** (7) | Upload from disk, URL or base64; stock photos; alt-text audits |
| **Themes** (15) | Sandboxed drafts, classic PHP + Tailwind scaffolding, preview, publish |
| **Appearance** (23) | Menus, widgets, block templates, global styles, Customizer |
| **Users & comments** (12) | Full CRUD, roles, bulk moderation |
| **Plugins** (9) | Install, activate, update; search WordPress.org |
| **Site** (11) | Settings, health, versions, database size, rendered page HTML |
| **Power** (12) | WP-CLI, guarded SQL, Abilities API, snippets, editable fields |
| **Bulk & audit** (3) | Dry-run bulk edits, content and media audits |
| **Multi-site** (4) | One server, many sites; every tool takes `site_id` |
| **Playbooks** (4) | Eight built-in skills the agent loads before it works |

**[Full tool reference →](docs/TOOLS.md)**

---

## Documentation

| | |
| --- | --- |
| [Deploy to Cloudflare](docs/DEPLOY_CLOUDFLARE.md) | Secrets, custom domains, rotation, troubleshooting |
| [WordPress auth](docs/WORDPRESS_AUTH.md) | Application Passwords, roles, HTTPS, header passthrough |
| [Tool reference](docs/TOOLS.md) | Every tool, grouped |
| [Comparison](docs/COMPARISON.md) | Versus other WordPress MCP servers |
| [Configuration](docs/CONFIGURATION.md) | Every option and precedence rule |
| [Companion plugin](docs/COMPANION_PLUGIN.md) | What it adds, how to install |
| [Security](SECURITY.md) | Threat model and guardrails |
| [Contributing](CONTRIBUTING.md) | Setup, conventions, adding a tool |

---

## Status

**v1.0.0.** CI across Node 20/22/24 and PHP 7.4/8.3, with the Worker build verified on every push.

Verified against a **live WordPress 7.1 install**, not only unit-tested: all 117 tools exercised, the full dry-run → confirm → apply cycle, and the same server again over HTTP. Every guardrail was confirmed to refuse — live-theme writes, path traversal, protected options, non-allowlisted commands, stacked SQL. That found and fixed twelve real bugs, including ability routes that matched the published docs but not core's actual registration, and confirmation tokens that could not survive between Cloudflare isolates.

The suites are in [`audit/`](audit/) and re-runnable against any throwaway WordPress: `npm run audit`.

Welcome next: more playbooks (WooCommerce, ACF, multisite), page-builder write paths that go through each builder's own save routine, and more WP-CLI commands for the allowlist. Issues and PRs are read — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Development

```bash
npm install && npm run build
npm test            # 56 tests, no network needed
npm run cf:dev      # the worker locally at :8787/mcp
```

Adding a tool is one `defineTool({...})` — it appears on both transports automatically.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the WordPress Foundation, Automattic, or Cloudflare.
