# Deploying wpxmcp to Cloudflare Workers

Running wpxmcp as a **remote MCP server** means your WordPress credentials live in Cloudflare's secret store instead of on every machine that wants to use them. Clients authenticate to your Worker with a single bearer token; the Worker holds the WordPress credentials and never discloses them.

```
MCP client  ──HTTPS + Bearer──▶  Cloudflare Worker  ──Application Password──▶  WordPress
(Claude, Cursor,                 (holds the secrets)                          (your sites)
 ChatGPT, …)
```

---

## 1. One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alokemajumder/wpxmcp)

The button clones this repository into your own GitHub or GitLab account, creates the Worker, and configures Workers Builds so every push to your production branch redeploys.

Cloudflare reads the secrets it needs from two files in the repository:

- **`.dev.vars.example`** lists the secret names in dotenv format (`WPX_AUTH_TOKEN`, `WPX_SITES`).
- **`package.json`** describes each one under `cloudflare.bindings`, so the setup screen explains what to paste.

You should therefore be prompted for both secrets during setup. **Confirm afterwards** with the health check in [step 4](#4-deploy) — if `auth_configured` is `false`, set them with `wrangler secret put` as in [step 3](#3-store-your-credentials-as-secrets). Never commit a real secret to the repository; the button flow is the only place credentials should be entered.

Requirements for the button to work at all, which this repository already satisfies:

| Requirement | Here |
| --- | --- |
| Public GitHub or GitLab repository | Yours must be public for others to use your button |
| `wrangler.json` or `wrangler.toml` at the root | [`wrangler.json`](../wrangler.json) |
| A `deploy` script, or it falls back to `npx wrangler deploy` | `npm run deploy` |
| Secrets declared in `.dev.vars.example` | [`.dev.vars.example`](../.dev.vars.example) |
| Binding descriptions in `package.json` | `cloudflare.bindings` |

> **Deploying your own fork?** Update the button URL in `README.md` and in this file to point at your repository — the button deploys whatever repository the `?url=` parameter names.

---

## 2. Manual deploy

```bash
git clone https://github.com/alokemajumder/wpxmcp.git
cd wpxmcp
npm install
npx wrangler login
```

Optionally rename the Worker in `wrangler.json` (`"name": "wpxmcp"`) — this becomes your subdomain.

---

## 3. Store your credentials as secrets

Worker Secrets are encrypted at rest, are not readable back from the dashboard or CLI, and are never written to your repository. This is the only place WordPress credentials belong.

### The access token (required)

Without it the Worker refuses every request, because a Worker holding site credentials with no authentication is an open door to your WordPress installs.

```bash
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
```

Save the value it printed — clients need it, and you cannot read it back.

### Your WordPress sites (required)

**Several sites**, as one JSON secret:

```bash
npx wrangler secret put WPX_SITES
```

Paste, then press Ctrl-D:

```json
[
  { "id": "main", "url": "https://example.com", "username": "admin", "appPassword": "abcd EFGH ijkl MNOP qrst UVWX" },
  { "id": "shop", "url": "https://shop.example.com", "username": "admin", "appPassword": "abcd EFGH ijkl MNOP qrst UVWX" },
  { "id": "prod", "url": "https://www.example.com", "username": "editor", "appPassword": "abcd EFGH ijkl MNOP qrst UVWX", "writable": false }
]
```

**A single site**, if you prefer three separate secrets:

```bash
npx wrangler secret put WORDPRESS_URL
npx wrangler secret put WORDPRESS_USERNAME
npx wrangler secret put WORDPRESS_APP_PASSWORD
```

### Optional secrets

```bash
npx wrangler secret put UNSPLASH_ACCESS_KEY   # stock photo search
npx wrangler secret put PEXELS_API_KEY        # stock photo search
npx wrangler secret put WPX_DEFAULT_SITE      # which site_id is assumed when omitted
```

### Where each WordPress credential comes from

In each WordPress site: **Users → Profile → Application Passwords** → name it `wpxmcp` → **Add New**. Copy the generated value including its spaces. Application Passwords are revocable individually, so removing this integration later never disturbs the account's real password.

Give the account the least role that does the job. `manage_options` is required for settings, plugins, themes, WP-CLI and SQL; Editor is enough for content work.

---

## 4. Deploy

```bash
npm run deploy
```

Wrangler prints your URL. Confirm it is alive:

```bash
curl https://wpxmcp.<your-subdomain>.workers.dev/health
```

```json
{
  "service": "wpxmcp",
  "version": "1.0.0",
  "runtime": "cloudflare-workers",
  "transport": "streamable-http (stateless)",
  "endpoint": "/mcp",
  "auth_configured": true
}
```

`"auth_configured": false` means `WPX_AUTH_TOKEN` did not get set — go back to step 3. The health endpoint is deliberately unauthenticated and deliberately reveals nothing about your sites.

Then check the MCP endpoint itself:

```bash
curl -s https://wpxmcp.<your-subdomain>.workers.dev/mcp \
  -H "Authorization: Bearer $WPX_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400
```

---

## 5. Connect a client

### Claude Code

```bash
claude mcp add --transport http wpxmcp https://wpxmcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <your WPX_AUTH_TOKEN>"
```

### Claude Desktop, Cursor, and other JSON-configured clients

```jsonc
{
  "mcpServers": {
    "wpxmcp": {
      "type": "http",
      "url": "https://wpxmcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your WPX_AUTH_TOKEN>"
      }
    }
  }
}
```

### Browser-based clients

Set the origins allowed to call your Worker, in `wrangler.json`:

```jsonc
"vars": {
  "WPX_ALLOWED_ORIGINS": "https://claude.ai,https://chatgpt.com"
}
```

Redeploy afterwards. Leave it empty for clients that are not browsers — CORS is irrelevant to them, and an empty allowlist is the safer default.

Ask the client: *"List my WordPress sites."*

---

## 6. Local development

`wrangler dev` reads secrets from a gitignored `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
npm run cf:dev
```

The Worker runs at `http://localhost:8787/mcp`. `.dev.vars` is gitignored — keep it that way.

---

## 7. Custom domain

A `workers.dev` subdomain is fine, but a custom hostname is stable across renames and easier to rotate behind.

Add a route to `wrangler.json`:

```jsonc
"routes": [
  { "pattern": "mcp.example.com", "custom_domain": true }
]
```

Redeploy. Cloudflare provisions the certificate; the zone must be on your Cloudflare account.

---

## 8. Durable audit trail (optional)

Workers isolates are evicted freely, so the in-memory audit ring is best-effort. For a log that survives, bind a KV namespace:

```bash
npx wrangler kv namespace create WPX_AUDIT
```

Add this to `wrangler.json`, pasting the id Wrangler printed:

```json
"kv_namespaces": [
  { "binding": "WPX_AUDIT", "id": "abc123..." }
]
```

`wrangler.json` is strict JSON — no comments and no trailing commas, or the deploy button's parser will reject it.

Entries are written with a 90-day TTL. Independently of this, the companion plugin keeps its own append-only log on each WordPress site, which is the record that matters when you are reconstructing what changed.

---

## Rotating and revoking

**Rotate the access token** (do this if it may have leaked):

```bash
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
```

It takes effect within seconds. Every client needs the new value.

**Rotate a WordPress credential:** revoke the Application Password in wp-admin, create a new one, and `npx wrangler secret put WPX_SITES` again with the updated JSON.

**Take the whole thing offline:**

```bash
npx wrangler delete
```

Then revoke the Application Passwords in wp-admin. Deleting the Worker stops access through it; revoking in WordPress is what actually invalidates the credential.

---

## Local versus remote

| | Local (stdio) | Remote (Workers) |
| --- | --- | --- |
| Credentials live | On your machine | In Cloudflare Secrets |
| Setup per machine | Each one needs configuring | Paste one URL and token |
| `create_media` with `file_path` | ✅ Reads your disk | ❌ No shared filesystem — use `url` or `base64_data` |
| `save_skill` | ✅ Writes to `~/.wpxmcp/skills` | ❌ Add playbooks to `skills/` and redeploy |
| Audit log | Append-only file | In-memory, or KV |
| Everything else | Identical | Identical |

Both entry points build from the same `src/toolset.ts`, so the tool surface cannot drift. The two limitations above are inherent to not having a filesystem, and the affected tools say so plainly when called.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `503` with a message about `WPX_AUTH_TOKEN` | The token secret is not set. Step 3. |
| `401 Unauthorized` | The token is missing or wrong. Check the `Authorization: Bearer …` header. |
| `No WordPress sites are configured` | `WPX_SITES` is unset or malformed. It must be a JSON **array** or object map. |
| `Could not parse WPX_SITES` | Invalid JSON — usually a smart quote from copy-paste, or a missing comma. |
| Timeouts against one site | Raise `timeoutMs` on that site. Workers allow up to 300s. |
| Site returns HTML, not JSON | A security plugin or WAF is challenging the Worker. Allowlist Cloudflare, or check the REST prefix. |
| 401 from WordPress itself | The host is stripping the `Authorization` header — add the passthrough rule in [CONFIGURATION.md](CONFIGURATION.md). |
| A browser client is blocked | Set `WPX_ALLOWED_ORIGINS` and redeploy. |

Live logs:

```bash
npm run cf:tail
```

---

## Cost

Cloudflare's free tier covers 100,000 requests a day. Each MCP message is one request, and a stateless server holds nothing open between them, so ordinary use sits comfortably inside the free tier. KV, if you enable it, has its own free allowance.
