---
name: site-setup
title: Connecting a WordPress site
description: How to connect a self-hosted WordPress site, generate credentials, and diagnose the auth failures that actually happen.
keywords: connect, setup, credentials, application password, 401, authentication, getting started, configure
---

## Connect a site

1. **Generate an Application Password** in WordPress:
   `wp-admin → Users → Profile → Application Passwords → New Application Password Name → Add New`.
   Copy the generated value. It looks like `abcd EFGH ijkl MNOP qrst UVWX` — keep the spaces, they are fine.

2. **Configure the MCP server** with one of:

   ```jsonc
   // ~/.wpxmcp/sites.json — many sites
   {
     "sites": [
       { "id": "main",    "url": "https://example.com",      "username": "admin", "appPassword": "abcd EFGH ijkl MNOP" },
       { "id": "staging", "url": "https://staging.example.com", "username": "admin", "appPassword": "...", "allowInsecureTLS": true }
     ]
   }
   ```

   ```bash
   # or environment variables — single site
   WORDPRESS_URL=https://example.com
   WORDPRESS_USERNAME=admin
   WORDPRESS_APP_PASSWORD="abcd EFGH ijkl MNOP"
   ```

3. **Verify** with `test_site`. It checks reachability, authentication, the role's capabilities, and whether the companion plugin is present — and names the specific problem when something is wrong.

## Install the companion plugin

Core REST cannot do everything. The companion plugin (`wp-plugin/wpxmcp-helper`) adds the things WordPress does not expose over REST: SQL, WP-CLI emulation, theme file access and drafts, unregistered post meta, theme mods, options, site health and editable fields.

Zip the `wpxmcp-helper` folder → `Plugins → Add New → Upload Plugin` → activate. Run `test_site` again; the `wpxmcp/v1` namespace should appear.

Everything else — posts, pages, media, taxonomies, users, comments, plugins, menus, widgets — works without it.

## Auth failures and what they actually mean

| Symptom | Cause | Fix |
| --- | --- | --- |
| 401 on every request | The host strips the `Authorization` header | Add the passthrough rule below |
| 401 with correct credentials | Application Passwords disabled, or the site is not on HTTPS | WordPress disables them over plain HTTP unless `WP_ENVIRONMENT_TYPE` is `local` |
| 403 on writes only | The role is too low | Use an Editor or Administrator account |
| `rest_no_route` | A security plugin disabled the REST API, or the URL is wrong | Check `discover_rest_routes` |
| HTML returned instead of JSON | A WAF or security plugin is serving a challenge page | Allowlist the server's IP |
| 404 on every route | No pretty permalinks | Set `"restPrefix": "/?rest_route="` on the site config |

Apache passthrough, in `.htaccess` above the WordPress block:

```apache
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%1]
```

Nginx + php-fpm, in the `location ~ \.php$` block:

```nginx
fastcgi_param HTTP_AUTHORIZATION $http_authorization;
```

## Multiple sites

Every content, taxonomy, media, user and admin tool takes an optional `site_id`. With one site configured it is optional. With several, name the site or the default (first, or `WPX_DEFAULT_SITE`) is used. `list_sites` shows the ids.

Mark production read-only while experimenting:

```json
{ "id": "prod", "url": "https://example.com", "username": "...", "appPassword": "...", "writable": false }
```
