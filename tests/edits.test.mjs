import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, summarizeContent, extractSeo } from "../dist/lib/content-utils.js";

test("a literal edit replaces a unique match", () => {
  const result = applyEdits("<p>Old price: $10</p>", [{ find: "$10", replace: "$12" }]);
  assert.equal(result.content, "<p>Old price: $12</p>");
  assert.equal(result.changed, true);
});

test("an ambiguous edit fails rather than guessing", () => {
  assert.throws(
    () => applyEdits("<p>a</p><p>a</p>", [{ find: "<p>a</p>", replace: "<p>b</p>" }]),
    /ambiguous/
  );
});

test("all:true replaces every occurrence", () => {
  const result = applyEdits("<p>a</p><p>a</p>", [{ find: "<p>a</p>", replace: "<p>b</p>", all: true }]);
  assert.equal(result.content, "<p>b</p><p>b</p>");
  assert.equal(result.applied[0].occurrences, 2);
});

test("a missing target fails loudly by default", () => {
  assert.throws(() => applyEdits("<p>hello</p>", [{ find: "goodbye", replace: "x" }]), /does not appear/);
});

test("required:false downgrades a miss to a skip", () => {
  const result = applyEdits("<p>hello</p>", [{ find: "goodbye", replace: "x", required: false }]);
  assert.equal(result.changed, false);
  assert.equal(result.skipped.length, 1);
});

test("regex edits work across newlines", () => {
  const result = applyEdits("<div>\n  keep\n</div>", [{ find: "<div>.*?</div>", replace: "<span/>", regex: true }]);
  assert.equal(result.content, "<span/>");
});

test("edits apply in order, so a later edit sees the earlier result", () => {
  const result = applyEdits("a", [
    { find: "a", replace: "b" },
    { find: "b", replace: "c" },
  ]);
  assert.equal(result.content, "c");
});

test("block delimiters survive a targeted edit", () => {
  const before = "<!-- wp:paragraph -->\n<p>Old</p>\n<!-- /wp:paragraph -->";
  const result = applyEdits(before, [{ find: "<p>Old</p>", replace: "<p>New</p>" }]);
  assert.equal(result.content, "<!-- wp:paragraph -->\n<p>New</p>\n<!-- /wp:paragraph -->");
});

test("a summary omits the body but counts its words", () => {
  const summary = summarizeContent({
    id: 7,
    title: { rendered: "Hello &amp; welcome" },
    content: { raw: "<p>one two three four five</p>" },
    excerpt: { rendered: "" },
    slug: "hello",
    status: "publish",
    categories: [3],
  }, "post");

  assert.equal(summary.id, 7);
  assert.equal(summary.title, "Hello & welcome");
  assert.equal(summary.word_count, 5);
  assert.deepEqual(summary.taxonomies.categories, [3]);
  assert.equal(summary.content, undefined, "a summary must never carry the body");
});

test("SEO extraction recognises each supported plugin", () => {
  assert.equal(extractSeo({ meta: { rank_math_title: "T" } }).plugin, "rank-math");
  assert.equal(extractSeo({ meta: { _aioseo_title: "T" } }).plugin, "aioseo");
  assert.equal(extractSeo({ meta: { _seopress_titles_title: "T" } }).plugin, "seopress");
  assert.equal(extractSeo({ yoast_head_json: { title: "T" } }).plugin, "yoast");
  assert.equal(extractSeo({ meta: {} }).plugin, null);
});
