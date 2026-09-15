---
name: site-setup
title: Connecting a WordPress site
description: Use when connecting a new WordPress site to wpxmcp, creating an Application Password, installing the companion plugin, or fixing authentication and connection failures.
keywords: connect, connect a site, connect a new site, add site, setup, set up, getting started, configure, credentials, application password, app password, authentication, 401, unauthorized, sites.json, companion plugin, wpxmcp-helper, install helper, rest api disabled, authorization header
---

## When this applies

First-time setup, adding a site, or `test_site` reporting a connection or authentication problem.

## Rules

1. Never ask for the account's login password. wpxmcp uses an Application Password (or a bearer token), which can be revoked on its own.
2. Use an Administrator account when plugin, theme, user or settings work is expected; Editors can manage content only.
3. Application Passwords only work over HTTPS, or when `WP_ENVIRONMENT_TYPE` is `local`. Some security plugins disable them.
4. Mark production `"writable": false` while experimenting; every write tool then refuses.
5. Credentials never go into skills, content or reports.

## Procedure

1. In wp-admin: Users → Profile → Application Passwords → name it (for example "wpxmcp") → Add New Application Password. Copy the value; spaces are fine.
2. Configure one of:

```jsonc
// ~/.wpxmcp/sites.json (or WPX_SITES_FILE=path, or WPX_SITES=inline JSON on Workers)
{ "sites": [
  { "id": "main", "url": "https://example.com", "username": "admin", "appPassword": "abcd EFGH ijkl MNOP qrst UVWX" },
  { "id": "staging", "url": "https://staging.example.com", "username": "admin", "appPassword": "…", "allowInsecureTLS": true, "writable": false }
] }
```

   Single site via environment: `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`. Several via `WP_SITE_{ID}_URL`, `WP_SITE_{ID}_USERNAME`, `WP_SITE_{ID}_APP_PASSWORD`. Optional per site: `restPrefix`, `headers` (for Cloudflare Access or basic-auth gates), `timeoutMs`. The default site is `WPX_DEFAULT_SITE` or the first one.
3. `test_site` (with `site_id` when several exist). It reports reachability, the authenticated user, roles and capabilities, and whether the companion plugin is active.
4. Companion plugin: zip `wp-plugin/wpxmcp-helper` → Plugins → Add New → Upload Plugin → Activate. It adds WP-CLI emulation, SQL, theme files and drafts, unregistered meta, options, theme mods, editable fields, error log, cache purge, backup status, profiler and the inspect tools. Core content, media, users, comments, menus, plugins and themes work without it.
5. `test_site` again, then `get_site` for versions, permalinks and available capabilities.

## Verify

`test_site` shows authenticated as the expected user with the expected role, and the companion plugin as detected when installed. `list_sites` shows the id to pass as `site_id`.

## Report back

Which sites are connected, as which user and role, whether each is writable, and whether the companion plugin is active (and what is unavailable without it).

## Reference: failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| 401 on every request, correct password | Host strips the `Authorization` header | Passthrough rule below |
| 401 on a plain-HTTP site | Application Passwords unavailable without HTTPS | Enable HTTPS, or set `WP_ENVIRONMENT_TYPE` to `local` on a dev install |
| 401 `incorrect_password` / `invalid_username` | Wrong or revoked credential | Create a new Application Password |
| 403 on writes only | Role too low, or a security plugin blocks REST writes | Administrator account; allowlist in the security plugin |
| `rest_no_route` on everything | REST disabled by a security plugin, or wrong URL | Re-enable REST for authenticated users; check `url` |
| 404 on every route | Plain permalinks, so `/wp-json/` does not exist | `"restPrefix": "/?rest_route="` |
| HTML instead of JSON | WAF or bot-protection challenge | Allowlist the server's IP or add `headers` |

```apache
# .htaccess, above the WordPress block
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]
```

```nginx
# inside location ~ \.php$
fastcgi_param HTTP_AUTHORIZATION $http_authorization;
```
