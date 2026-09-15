# Configuration

## Precedence

The site list is resolved from the first source that yields anything:

1. `WPX_SITES` — inline JSON
2. `WPX_SITES_FILE` — path to a JSON file
3. `~/.wpxmcp/sites.json`, then `./wpxmcp.sites.json`
4. `WP_SITE_<ID>_*` environment triples
5. `WORDPRESS_URL` / `WORDPRESS_USERNAME` / `WORDPRESS_APP_PASSWORD`

`list_sites` reports which source was used, so there is never any doubt.

---

## Site options

```jsonc
{
  "id": "main",                    // required — how tools address this site
  "name": "Main site",             // display label
  "url": "https://example.com",    // required; https:// is assumed; trailing slash, a pasted /wp-json, query and fragment are dropped

  "username": "admin",             // WordPress username
  "appPassword": "abcd EFGH ...",  // Application Password; keep the spaces
  "bearerToken": "...",            // alternative: a JWT, or a proxy-injected token

  "restPrefix": "/wp-json",        // "/?rest_route=" for sites without pretty permalinks
  "headers": { "CF-Access-Client-Id": "..." },  // merged into every request
  "allowInsecureTLS": false,       // accept self-signed certs (staging only; ignored on Workers)
  "timeoutMs": 60000,              // per-request timeout, covering the response body too
  "writable": true,                // false makes the site read-only at the server
  "helperNamespace": "wpxmcp/v1"   // companion plugin namespace
}
```

`WPX_SITES` accepts an array, `{ "sites": [...] }`, or an object map keyed by id. snake_case spellings (`app_password`, `rest_prefix`, `allow_insecure_tls`, `timeout_ms`, `bearer_token`, `helper_namespace`) are accepted too.

Configuration is validated when it loads, and a mistake stops the server with a message naming the site and the field:

- `writable` and `allowInsecureTLS` must be booleans. The strings `"true"`/`"false"` (and `1`/`0`, `yes`/`no`, `on`/`off`) are read as such; anything else is an error, so `"writable": "false"` can never silently leave a site writable.
- `timeoutMs` must be a positive number.
- Duplicate site ids, and a `WPX_DEFAULT_SITE` that names no configured site, are errors.
- A JSON parse error reports only the position, never the text around it, because that text may be a password.

---

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WPX_SITES` | Inline JSON site list |
| `WPX_SITES_FILE` | Path to a JSON site list (not available on Workers, which have no filesystem) |
| `WPX_DEFAULT_SITE` | Which `site_id` is assumed when omitted. `WORDPRESS_DEFAULT_SITE` is accepted as an alias. Defaults to the first site |
| `WORDPRESS_URL` / `WORDPRESS_USERNAME` / `WORDPRESS_APP_PASSWORD` | Single-site shorthand. Optional companions: `WORDPRESS_SITE_ID`, `WORDPRESS_SITE_NAME`, `WORDPRESS_TOKEN` (bearer token), `WORDPRESS_REST_PREFIX`, `WORDPRESS_ALLOW_INSECURE_TLS`. `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` and `WORDPRESS_PASSWORD` are accepted as aliases |
| `WP_SITE_<ID>_URL` / `_USERNAME` / `_APP_PASSWORD` / `_NAME` / `_TOKEN` / `_REST_PREFIX` / `_READONLY` / `_ALLOW_INSECURE_TLS` | One site per group. `_PASSWORD` is an alias of `_APP_PASSWORD`; `_READONLY` and `_ALLOW_INSECURE_TLS` take `true` |
| `WPX_HOME` | Where the audit log, the confirmation-token key and saved skills live. Default `~/.wpxmcp` |
| `WPX_AUDIT` | **Local:** set to `off` to disable local audit logging. **Workers:** the name of the optional KV binding for a durable audit trail |
| `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` | Stock photo search |
| `WPX_ALLOW_PRIVATE_URLS` | Set to `true` to let `create_media` (downloads by `url`) and `check_links` (external links) reach private, loopback and local-network addresses. Off by default, because those fetches run with the server's own network access. The configured WordPress host is always allowed |
| `WPX_AUTH_TOKEN` | **Workers only** — the bearer token clients must present |
| `WPX_ALLOWED_ORIGINS` | **Workers only** — comma-separated CORS origins, or `*` |

---

## Credentials

**Application Passwords** are the supported mechanism: **Users → Profile → Application Passwords**. They are revocable individually, so removing this integration never disturbs the account's real password. Keep the spaces in the generated value.

WordPress disables Application Passwords over plain HTTP unless `WP_ENVIRONMENT_TYPE` is `local`. Use HTTPS.

**Least privilege.** `manage_options` (Administrator) is required for settings, plugins, themes, WP-CLI, SQL and the companion plugin's endpoints — on multisite the plugin requires a network super admin. Editor is enough for content, media and taxonomy work — and is the better choice if that is all you need.

---

## Authorization header passthrough

Some hosts strip the `Authorization` header before PHP sees it, which produces a 401 with credentials that are entirely correct — the single most common setup failure.

**Apache** — in `.htaccess`, above the WordPress block:

```apache
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]
```

**Nginx + php-fpm** — inside the `location ~ \.php$` block:

```nginx
fastcgi_param HTTP_AUTHORIZATION $http_authorization;
```

`test_site` names this specifically when it detects the symptom.

---

## Sites without pretty permalinks

If `Settings → Permalinks` is set to Plain, REST is served from `?rest_route=` rather than `/wp-json/`:

```json
{ "id": "legacy", "url": "https://legacy.example.com", "restPrefix": "/?rest_route=" }
```

---

## Read-only production

```json
{ "id": "prod", "url": "https://example.com", "username": "...", "appPassword": "...", "writable": false }
```

Every write is refused at the server, before a request is made. Reads, audits and diagnostics still work — which makes this the right default while exploring an unfamiliar site.

---

## Verifying

```bash
npm run doctor
```

Reports the config source, each site's reachability, whether credentials authenticate, the role's capabilities, and whether the companion plugin is present. From inside a client, `test_site` does the same and returns structured checks.
