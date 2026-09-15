import type { WordPressClient } from "./client.js";

/**
 * Reads a response body up to `maxBytes`, cancelling the stream beyond that, so a
 * huge or endless page cannot exhaust memory in a tool call.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(buffer), bytes, truncated };
}

/**
 * The companion plugin's namespace, or an error that tells a person exactly how
 * to install it. `why` replaces the default explanation of why core cannot do this.
 */
export async function requireHelper(client: WordPressClient, tool: string, why = "Core WordPress exposes no REST route for this."): Promise<string> {
  const ns = client.site.helperNamespace ?? "wpxmcp/v1";
  if (!(await client.hasHelperPlugin())) {
    throw new Error(
      `"${tool}" needs the wpxmcp companion plugin, which is not active on "${client.site.id}". ${why} Install wp-plugin/wpxmcp-helper from this repo: zip the folder, upload it under Plugins → Add New → Upload Plugin, activate it, then run test_site to confirm the ${ns} namespace appears.`
    );
  }
  return ns;
}
