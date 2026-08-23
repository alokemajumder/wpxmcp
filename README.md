# wpxmcp

**An MCP server that manages self-hosted WordPress sites — content, design, themes, plugins, menus, widgets, users and the database — from any MCP client.**

Run it locally over stdio, or deploy it to Cloudflare Workers as a remote MCP server with credentials held in Worker Secrets.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpxmcp/wpxmcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-black.svg)](https://modelcontextprotocol.io)

> Self-hosted WordPress only. WordPress.com sites do not expose the REST endpoints or filesystem this depends on.

---

## What it does

**117 tools** across every part of a WordPress site:

| Area | What you get |
| --- | --- |
| **Multi-site** | One server, many sites. Every tool takes an optional `site_id`. |
| **Content** | Nine tools covering posts, pages and *any* custom post type, with targeted partial edits and URL resolution. |
| **Taxonomies** | Eight tools covering categories, tags and any custom taxonomy. |
| **Media** | Upload from a local path, a remote URL, or base64. Stock photo search. Alt-text auditing. |
| **Design & themes** | Sandboxed theme drafts, classic PHP + Tailwind scaffolding, private preview URLs, backed-up publishes. |
| **Appearance** | Menus, menu items, widgets, sidebars, block templates, global styles, Customizer settings. |
| **Users & comments** | Full CRUD, roles, bulk moderation. |
| **Plugins** | Install, activate, update, delete; search the WordPress.org repository. |
| **Site intelligence** | Versions, health checks, database size, updates, and the rendered HTML of any page. |
| **Power tools** | Emulated WP-CLI, guarded SQL, the Abilities API, code snippets, editable fields, and a raw REST escape hatch. |
| **Bulk & audit** | Dry-run bulk edits, content and media audits, an append-only action log. |
| **Playbooks** | Eight built-in skills the agent loads before it works — and you can save your own. |

Full reference: **[docs/TOOLS.md](docs/TOOLS.md)**.

---

## Quick start (local, stdio)

```bash
git clone https://github.com/wpxmcp/wpxmcp.git
cd wpxmcp
npm install
npm run build
```

Generate an Application Password in WordPress: **Users → Profile → Application Passwords**.

Add wpxmcp to your MCP client. For **Claude Code**:

```bash
claude mcp add wpxmcp -- node /absolute/path/to/wpxmcp/dist/index.js \
  -e WORDPRESS_URL=https://example.com \
  -e WORDPRESS_USERNAME=admin \
  -e "WORDPRESS_APP_PASSWORD=abcd EFGH ijkl MNOP qrst UVWX"
```

For **Claude Desktop**, **Cursor**, or any client using a JSON config:

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

It reports reachability, authentication, the role's capabilities, and whether the companion plugin is installed — naming the specific misconfiguration rather than failing generically.

---

## Quick start (remote, Cloudflare Workers)

One click, or three commands:

```bash
npm install
npx wrangler secret put WPX_AUTH_TOKEN      # openssl rand -hex 32
npx wrangler secret put WPX_SITES           # the JSON array of your sites
npm run cf:deploy
```

Your server is then at `https://wpxmcp.<subdomain>.workers.dev/mcp`, speaking Streamable HTTP.

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

**WordPress credentials never leave Cloudflare's secret store** — they are not in the repository, not in `wrangler.jsonc`, and not in any client's configuration. The client only ever holds the bearer token for your Worker.

Full walkthrough, including custom domains, KV audit storage and rotation: **[docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md)**.

---

## Managing several sites

```json
{
  "sites": [
    { "id": "blog",    "url": "https://blog.example.com",    "username": "admin", "appPassword": "..." },
    { "id": "shop",    "url": "https://shop.example.com",    "username": "admin", "appPassword": "..." },
    { "id": "prod",    "url": "https://example.com",         "username": "admin", "appPassword": "...", "writable": false }
  ]
}
```

Point `WPX_SITES_FILE` at that file, drop it at `~/.wpxmcp/sites.json`, or inline it as `WPX_SITES`. Then:

> "Publish the draft about pricing on **shop**, then check it renders."

`"writable": false` makes a site read-only at the server, so an agent cannot write to production while you experiment. See [sites.example.json](sites.example.json) for every option.

---

## The companion plugin

Core WordPress REST cannot reach some things at all. The optional plugin in [`wp-plugin/wpxmcp-helper`](wp-plugin/wpxmcp-helper) adds:

- **Emulated WP-CLI** — 50+ commands in PHP. No binary, no SSH, no shell.
- **SQL** — read-only by default, with keyword blocking and an enforced row limit.
- **Theme files and drafts** — the sandboxed edit/preview/publish workflow.
- **Unregistered post meta** — the keys `show_in_rest` hides, including page-builder documents.
- **Options, theme mods, roles, site health, code snippets, editable fields.**

Install: zip the `wpxmcp-helper` folder → **Plugins → Add New → Upload Plugin** → activate. Then run `test_site`.

Everything else — posts, pages, media, taxonomies, users, comments, plugins, menus, widgets, block templates — works without it.

---

## Safety

An agent with write access to production needs guardrails that hold even when it is confidently wrong.

| Guardrail | Behaviour |
| --- | --- |
| **Application Passwords** | Standard WordPress auth, revocable per-integration, never a real account password. |
| **Roles are respected** | WordPress enforces capabilities. Settings, plugins, themes, WP-CLI and SQL need an administrator. |
| **Posts default to draft** | `create_content` never publishes unless you pass `status: "publish"`. |
| **Deletes go to trash** | Permanent deletion needs `force` **and** `confirm`, and previews what would be destroyed first. |
| **Default-deny CLI allowlist** | Only listed commands run. Shell metacharacters are refused; `wp eval` is disabled. |
| **SQL is SELECT-only** | Mutations need `allow_mutation`, a `confirm_token`, *and* a `wp-config.php` opt-in. Stacked statements are always refused. |
| **Themes are sandboxed** | Writing to a live theme is refused. Publishing backs up the previous theme first. |
| **PHP is syntax-checked** | Theme files and snippets are linted before they are written, so a parse error cannot fatal the site. |
| **Snippets land disabled** | New code never runs until a human enables it in wp-admin. |
| **Dry runs before damage** | Bulk edits, `search-replace` and mutating SQL preview first and return a single-use token bound to those exact arguments. |
| **Read-only sites** | `"writable": false` refuses every write at the server. |
| **Append-only audit log** | Every sensitive action, locally and on the site. `get_audit_log` answers "what did it change?" |
| **Remote auth required** | A Worker without `WPX_AUTH_TOKEN` refuses every request rather than running wide open. |

Details and threat model: **[SECURITY.md](SECURITY.md)**.

---

## How it thinks

A few design decisions that matter more than the tool count:

**Targeted edits, not rewrites.** `update_content` takes `edits: [{find, replace}]`, so changing one price does not mean re-sending a 3,000-word page. An edit that matches nothing **fails loudly** rather than silently writing nothing — the failure mode that quietly destroys content.

**URL in, content out.** `find_content_by_url` takes any link a human hands you and resolves it, detecting the post type from the URL shape (`/documentation/intro/` → the `documentation` CPT) via explicit ids, the site's own search index, registered rewrite bases, then a slug sweep.

**Classic PHP + Tailwind for themes.** Models write cleaner, more predictable classic templates than nested block markup — and the output is diffable and reviewable. Design tokens live in one `theme.css`; templates only ever reference them.

**Verify on the front end.** `get_page_html` fetches what a visitor actually receives. An API that returns 200 proves nothing when a page cache sits in front of it.

**Playbooks before work.** `load_skill` returns a focused guide for the task — and the page-builder one exists because editing an Elementor post as HTML silently corrupts the layout.

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/TOOLS.md](docs/TOOLS.md) | Every tool, grouped, with what it is for |
| [docs/DEPLOY_CLOUDFLARE.md](docs/DEPLOY_CLOUDFLARE.md) | Remote deployment, secrets, custom domains, rotation |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every configuration option and precedence rule |
| [docs/COMPANION_PLUGIN.md](docs/COMPANION_PLUGIN.md) | What the plugin adds and how to install it |
| [SECURITY.md](SECURITY.md) | Threat model, guardrails, reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, adding a tool, testing |

---

## Development

```bash
npm install
npm run build          # bundle skills, then compile
npm test               # 48 tests, no network required
npm run typecheck
npm run cf:dev         # run the Worker locally at http://localhost:8787/mcp
```

Adding a tool takes one `defineTool({...})` in the right `src/tools/*.ts` module — it is then automatically available over **both** stdio and HTTP, because both entry points build from the same `src/toolset.ts`.

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Requirements

- **Node.js 20+** for local use (24 recommended)
- **WordPress 6.0+**, self-hosted, with the REST API reachable
- **An Application Password** for a user with the capabilities you need
- **PHP 7.4+** if you install the companion plugin

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by the WordPress Foundation, Automattic, or Cloudflare.
