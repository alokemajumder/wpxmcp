import { test } from "node:test";
import assert from "node:assert/strict";
import { trimText, stripHtml, wordCount, unwrap } from "../dist/lib/tooling.js";

test("trimText marks where it truncated", () => {
  const out = trimText("x".repeat(100), 20);
  assert.ok(out.length < 100);
  assert.match(out, /truncated 80 more characters/);
});

test("truncated JSON must never be fed back to JSON.parse", () => {
  // Regression: rest_api sliced serialised JSON and re-parsed it, which throws
  // on any response larger than max_chars — exactly when trimming is needed.
  const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, s: "x".repeat(50) })) });
  const sliced = trimText(big, 500).replace(/\n…\[truncated[\s\S]*$/, "");
  assert.throws(() => JSON.parse(sliced), "slicing JSON produces unparseable text — truncate structurally instead");
});

test("stripHtml removes markup, scripts and entities", () => {
  assert.equal(stripHtml("<p>Hello &amp; welcome</p>"), "Hello & welcome");
  assert.equal(stripHtml("<script>evil()</script><p>Safe</p>"), "Safe");
  assert.equal(stripHtml("<!-- wp:paragraph --><p>Body</p>"), "Body");
});

test("wordCount counts visible words, not markup", () => {
  assert.equal(wordCount("<p>one two three</p>"), 3);
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("<!-- wp:paragraph --><p>one two</p><!-- /wp:paragraph -->"), 2);
});

test("unwrap prefers raw over rendered", () => {
  assert.equal(unwrap({ raw: "R", rendered: "D" }), "R");
  assert.equal(unwrap({ rendered: "D" }), "D");
  assert.equal(unwrap("plain"), "plain");
  assert.equal(unwrap(null), "");
});
