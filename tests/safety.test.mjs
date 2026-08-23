import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../dist/platform-node.js";
import {
  inspectSql, enforceRowLimit, inspectCliCommand,
  issueConfirmation, consumeConfirmation, fingerprintOp,
} from "../dist/lib/safety.js";

installNodePlatform();

test("SQL guard allows plain reads", () => {
  for (const q of ["SELECT * FROM wp_posts", "SHOW TABLES", "DESCRIBE wp_users", "EXPLAIN SELECT 1"]) {
    const verdict = inspectSql(q, false);
    assert.equal(verdict.allowed, true, `${q} should be allowed`);
    assert.equal(verdict.mutating, false);
  }
});

test("SQL guard blocks mutations without opt-in", () => {
  for (const q of ["DELETE FROM wp_posts", "UPDATE wp_posts SET x=1", "DROP TABLE wp_users", "TRUNCATE wp_options"]) {
    const verdict = inspectSql(q, false);
    assert.equal(verdict.allowed, false, `${q} should be blocked`);
    assert.match(verdict.reason ?? "", /allow_mutation/);
  }
});

test("SQL guard refuses stacked statements even when they start with SELECT", () => {
  const verdict = inspectSql("SELECT 1; DROP TABLE wp_users", true);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /Multiple statements/);
});

test("SQL guard sees through comments used to smuggle keywords", () => {
  const verdict = inspectSql("SELECT * FROM wp_posts /* comment */ WHERE 1", false);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.normalized.includes("comment"), false);
});

test("SQL guard permits a mutation once opted in", () => {
  const verdict = inspectSql("UPDATE wp_posts SET post_status='draft' WHERE ID=1", true);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.mutating, true);
});

test("row limit is appended only to unbounded selects", () => {
  assert.equal(enforceRowLimit("SELECT * FROM wp_posts", 50).query, "SELECT * FROM wp_posts LIMIT 50");
  assert.equal(enforceRowLimit("SELECT * FROM wp_posts LIMIT 5", 50).applied, false);
  assert.equal(enforceRowLimit("SHOW TABLES", 50).applied, false);
});

test("CLI allowlist matches the longest prefix", () => {
  const verdict = inspectCliCommand("plugin activate akismet/akismet");
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.matched, "plugin activate");
  assert.equal(verdict.write, true);
});

test("CLI allowlist tolerates a leading wp and reports reads", () => {
  const verdict = inspectCliCommand("wp plugin list --status=active");
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.write, false);
});

test("CLI allowlist denies anything unlisted", () => {
  const verdict = inspectCliCommand("db drop --yes");
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /default-deny/);
});

test("CLI allowlist rejects shell metacharacters", () => {
  const verdict = inspectCliCommand("plugin list; rm -rf /");
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /metacharacters/);
});

test("eval stays disabled unless explicitly enabled", () => {
  const verdict = inspectCliCommand("eval return_something");
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? "", /WPX_ALLOW_EVAL/);
});

test("a confirmation token is single use", () => {
  const fp = fingerprintOp(["a", 1]);
  const token = issueConfirmation("site", "summary", fp);
  assert.equal(consumeConfirmation(token, fp).valid, true);
  assert.equal(consumeConfirmation(token, fp).valid, false, "a token must not be reusable");
});

test("a confirmation token does not transfer to different arguments", () => {
  const token = issueConfirmation("site", "summary", fingerprintOp(["a", 1]));
  const result = consumeConfirmation(token, fingerprintOp(["a", 2]));
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /arguments changed/);
});

test("fingerprints are stable and argument-sensitive", () => {
  assert.equal(fingerprintOp(["x", { a: 1 }]), fingerprintOp(["x", { a: 1 }]));
  assert.notEqual(fingerprintOp(["x", { a: 1 }]), fingerprintOp(["x", { a: 2 }]));
});
