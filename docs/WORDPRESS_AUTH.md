# WordPress authentication

How wpxmcp authenticates to your sites, why it does it that way, and how to fix the failures that actually happen.

---

## What wpxmcp uses: Application Passwords

wpxmcp authenticates with **Application Passwords**, built into WordPress core since **5.6** and the mechanism WordPress designed for exactly this purpose.

An Application Password is a 24-character credential tied to a user account but **separate from that account's real password**. It authenticates REST API requests over HTTP Basic auth and can be revoked individually without disturbing the account.

```
Authorization: Basic base64(username:application-password)
```

wpxmcp builds that header for you. You never put a login password anywhere.

### Why not the alternatives

| Method | Why not |
| --- | --- |
| **Username + login password** | WordPress does not accept it for REST at all, and storing a login password in a config file is indefensible. |
| **Cookie + nonce** | Designed for JavaScript running inside an authenticated wp-admin page. Nonces expire in hours and cannot be obtained headlessly. |
| **JWT plugins** | Adds a third-party dependency and a second credential system. Supported via `bearerToken` if you already run one, but not required. |
| **OAuth** | WordPress core has no OAuth server. It would mean another plugin, for no gain over a revocable Application Password. |

If you already use a JWT or a proxy that injects auth, set `bearerToken` on the site instead of `username`/`appPassword`, and wpxmcp sends `Authorization: Bearer …`.

---

## Creating one

1. Log in to the site as the user you want wpxmcp to act as.
2. **Users → Profile** (or **Users → All Users → Edit** for someone else).
3. Scroll to **Application Passwords**.
4. Enter a name that identifies this integration — `wpxmcp`, or `wpxmcp (laptop)` if you will have several.
5. **Add New Application Password**.
6. Copy the generated value. **It is shown exactly once.**

The value looks like `abcd EFGH ijkl MNOP qrst UVWX`. **Keep the spaces** — WordPress strips them when checking, so either form works, and copying it verbatim is one less thing to get wrong.

WordPress records `last_used` and `last_ip` per Application Password, so you can see whether a credential is live and where it is being used from.

---

## Choosing the right user and role

Give wpxmcp the **least-privileged role that does the job**. WordPress enforces capabilities itself, so a lower role is a real, server-side boundary — not a convention wpxmcp is trusted to respect.

| Role | Can do | Cannot do |
| --- | --- | --- |
| **Administrator** | Everything: settings, plugins, themes, users, WP-CLI, SQL, the companion plugin's endpoints | — |
| **Editor** | All content, media, taxonomies, comments — including other people's | Settings, plugins, themes, users, WP-CLI, SQL |
| **Author** | Publish and manage only their own content, upload media | Other people's content, everything above |
| **Contributor** | Write drafts | Publish, upload media, everything above |
| **Subscriber** | Read, edit own profile | Essentially everything |

**Content and media work needs only Editor.** Reach for Administrator when you genuinely need settings, plugins, themes, WP-CLI, SQL, theme files or the companion plugin.

A practical pattern is a dedicated account — `ai-agent@example.com` with the Editor role — so its Application Passwords, capabilities and audit trail are separate from a human's.

`test_site` reports which capabilities the authenticated user actually holds, so you can confirm rather than assume.

---

## The HTTPS requirement

WordPress makes Application Passwords available **only over SSL, or in a local environment**. On a plain-HTTP production site the Application Passwords section does not appear at all.

This is `wp_is_application_passwords_available()`, and it is the correct behaviour: HTTP Basic auth sends a reusable credential in a header, and without TLS anyone on the path can read it.

**Use HTTPS.** If you are working against a local site that genuinely cannot have it, either set `WP_ENVIRONMENT_TYPE` to `local` in `wp-config.php`, or add to a must-use plugin:

```php
add_filter( 'wp_is_application_passwords_available', '__return_true' );
```

Never do that on a site reachable from the internet.

There is also `wp_is_application_passwords_available_for_user` for per-user control — useful if you want to permit Application Passwords for one service account and no one else.

---

## The single most common failure: a stripped Authorization header

Symptom: **401 with credentials that are completely correct.**

Cause: some server configurations discard the `Authorization` header before PHP ever sees it, so WordPress receives an unauthenticated request. Nothing about your credentials is wrong; they simply never arrive.

**Apache** — in `.htaccess`, *above* the `# BEGIN WordPress` block:

```apache
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]
```

Or, if `mod_setenvif` is available:

```apache
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```

**Nginx + php-fpm** — inside the `location ~ \.php$` block:

```nginx
fastcgi_param HTTP_AUTHORIZATION $http_authorization;
```

**LiteSpeed** — the Apache rule usually works; some hosts also need `CGIPassAuth On`.

`test_site` detects this pattern and names it specifically rather than reporting a generic authentication failure.

---

## Security plugins, firewalls and 2FA

**Two-factor authentication does not interfere.** Application Passwords deliberately bypass 2FA — that is the point of a separate machine credential. Your interactive logins stay protected.

**Security plugins often do interfere.** Wordfence, iThemes Security, All-In-One WP Security and similar can disable the REST API, block unauthenticated discovery, or rate-limit requests. If a site returns HTML instead of JSON, a WAF is serving a challenge page rather than passing the request through.

Fixes, in order of preference:

1. Allowlist the source IP. For a local server that is your machine; for a Cloudflare Worker it is Cloudflare's egress range, so prefer the next option.
2. Allowlist the `/wp-json/` path for authenticated requests.
3. Turn off the specific "disable REST API" setting rather than the whole plugin.

**Cloudflare Access or a staging gate** in front of the site: put the extra headers in the site config.

```json
{
  "id": "staging",
  "url": "https://staging.example.com",
  "username": "admin",
  "appPassword": "...",
  "headers": {
    "CF-Access-Client-Id": "...",
    "CF-Access-Client-Secret": "..."
  }
}
```

---

## Where credentials are stored

**Local (stdio):** in your MCP client's config, a `.env`, or `~/.wpxmcp/sites.json`. All are gitignored by this repository, but they are plain files on your disk — treat them as you would an SSH key.

**Remote (Cloudflare Workers):** in [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/), encrypted at rest and not readable back through the dashboard or CLI. They are not in the repository, not in `wrangler.json`, and not in any client's configuration. Clients hold only the bearer token for your Worker.

This is the main practical argument for the remote deployment: **one place holds the WordPress credentials**, rather than every laptop that wants access.

**No wpxmcp tool ever returns a credential.** `list_sites` and `get_site` report the *method* — `"application password"` — never the value. There is a test asserting this.

---

## Revoking and rotating

**Revoke:** **Users → Profile → Application Passwords → Revoke**. Effective immediately. Revoking one does not affect the account's other passwords, its login, or any other integration.

**Rotate:** create the new Application Password first, update the configuration, confirm with `test_site`, then revoke the old one. No downtime.

**Rotate the Worker's bearer token:**

```bash
openssl rand -hex 32 | npx wrangler secret put WPX_AUTH_TOKEN
```

**If you suspect compromise:** revoke the Application Password in wp-admin first. That is the action that actually invalidates access — deleting the Worker only closes one route to it.

---

## Verifying

```bash
npm run doctor
```

or, from inside a client, `test_site`. Both check, and report separately:

- Whether the REST API is reachable at all
- Whether credentials are configured
- Whether they authenticate, and as which user
- Which notable capabilities that user holds
- Whether the user is an administrator
- Whether the companion plugin is present

Each check names the specific misconfiguration and how to fix it, rather than reporting a generic failure.

---

## Quick reference

| Symptom | Cause | Fix |
| --- | --- | --- |
| No Application Passwords section in wp-admin | Site is not on HTTPS | Enable TLS, or the filter above for local sites |
| 401 with correct credentials | `Authorization` header stripped | Add the passthrough rule |
| 401 after a while | Password revoked, or the user deleted | Create a new one |
| 403 on writes only | Role too low | Use Editor or Administrator |
| 403 on everything | Security plugin blocking REST | Allowlist `/wp-json/` |
| HTML instead of JSON | WAF challenge page | Allowlist the source |
| 404 on every route | Plain permalinks | Set `restPrefix` to `/?rest_route=` |
| `rest_no_route` | REST API disabled by a plugin | Re-enable it; check `discover_rest_routes` |
