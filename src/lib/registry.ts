import { loadConfig, type ResolvedConfig, type SiteConfig } from "./config.js";
import { WordPressClient } from "./client.js";

/** Holds the configured sites and hands out (cached) clients. */
export class SiteRegistry {
  private clients = new Map<string, WordPressClient>();
  public readonly config: ResolvedConfig;

  constructor(config?: ResolvedConfig) {
    this.config = config ?? loadConfig();
  }

  get sites(): SiteConfig[] {
    return this.config.sites;
  }

  get defaultSiteId(): string | null {
    return this.config.defaultSiteId;
  }

  has(id: string): boolean {
    return this.config.sites.some((s) => s.id === id);
  }

  /**
   * Resolves `site_id` to a client. With one site configured, site_id is optional.
   * With several, an omitted site_id falls back to WPX_DEFAULT_SITE and says so.
   */
  resolve(siteId?: string): WordPressClient {
    if (this.config.sites.length === 0) {
      throw new Error(
        `No WordPress sites are configured. Set WORDPRESS_URL / WORDPRESS_USERNAME / WORDPRESS_APP_PASSWORD for a single site, or point WPX_SITES_FILE at a sites.json for several. See the README for the exact shape.`
      );
    }
    const id = siteId ?? this.config.defaultSiteId!;
    const site = this.config.sites.find((s) => s.id === id);
    if (!site) {
      throw new Error(
        `Unknown site_id "${siteId}". Configured sites: ${this.config.sites.map((s) => s.id).join(", ")}. Run list_sites to see them with their URLs.`
      );
    }
    let client = this.clients.get(site.id);
    if (!client) {
      client = new WordPressClient(site);
      this.clients.set(site.id, client);
    }
    return client;
  }

  /** Config with secrets removed, safe to return from tools. */
  redacted(site: SiteConfig) {
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      username: site.username ?? null,
      auth: site.bearerToken ? "bearer token" : site.username && site.appPassword ? "application password" : "none (anonymous, read-only)",
      rest_prefix: site.restPrefix,
      writable: site.writable !== false,
      allow_insecure_tls: Boolean(site.allowInsecureTLS),
      timeout_ms: site.timeoutMs,
      helper_namespace: site.helperNamespace,
      is_default: site.id === this.config.defaultSiteId,
      extra_headers: site.headers ? Object.keys(site.headers) : [],
    };
  }
}
