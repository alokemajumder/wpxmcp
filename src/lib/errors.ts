export class WPError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly url: string,
    public readonly method: string,
    public readonly body?: unknown,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "WPError";
  }

  /** Retry-After header from the response, when the server sent one. */
  public retryAfter: string | null = null;

  toReport(): string {
    const lines = [
      `WordPress request failed: ${this.method} ${this.url}`,
      `HTTP ${this.status}${this.code ? ` (${this.code})` : ""}: ${this.message}`,
    ];
    if (this.hint) lines.push(`Hint: ${this.hint}`);
    if (this.body !== undefined) {
      const dump = typeof this.body === "string" ? this.body : JSON.stringify(this.body, null, 2);
      if (dump && dump !== "{}") lines.push(`Response: ${dump.slice(0, 1500)}`);
    }
    return lines.join("\n");
  }
}

/** Maps the WordPress/REST failures people actually hit onto actionable advice. */
export function hintForFailure(status: number, code?: string): string | undefined {
  if (code === "rest_no_route") {
    return "That route is not registered. Run discover_content_types / discover_taxonomies to see what exists, confirm the owning plugin is active, or check that the REST API is not disabled.";
  }
  if (code === "rest_cannot_view" || code === "rest_forbidden_context") {
    return "The authenticated user lacks the capability for this request. Posts in a non-published status and most `edit` context fields require an Editor/Administrator role.";
  }
  if (code === "rest_cookie_invalid_nonce") {
    return "The site answered with a cookie-auth error, which usually means the Authorization header was stripped. Add the SetEnvIf/RewriteRule Authorization passthrough shown in the README.";
  }
  if (status === 401) {
    return "Authentication failed. Confirm the username and Application Password (Users -> Profile -> Application Passwords), keep the spaces in the password, and make sure the site is served over HTTPS.";
  }
  if (status === 403) {
    return "Authenticated but not permitted. Either the user's role is too low, or a security plugin (Wordfence, iThemes, Cloudflare) is blocking REST writes.";
  }
  if (status === 404) {
    return "Not found. Check the ID/slug, and verify the REST prefix — sites without pretty permalinks need restPrefix set to \"/?rest_route=\".";
  }
  if (status === 409) return "Conflict — the resource changed underneath this request. Re-read it and retry.";
  if (status === 413) return "The payload was too large. Raise upload_max_filesize/post_max_size, or upload the media in a smaller form.";
  if (status === 429) return "Rate limited by the host or a security plugin. Slow down and retry.";
  if (status >= 500) return "The site returned a server error. Check the PHP error log; a fatal in a plugin or theme usually surfaces here.";
  return undefined;
}
