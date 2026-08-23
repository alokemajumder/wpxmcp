import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../dist/platform-node.js";
import { listSkills, matchSkills, readSkill } from "../dist/lib/skills.js";

installNodePlatform();

test("every bundled playbook has the metadata matching depends on", () => {
  const skills = listSkills();
  assert.ok(skills.length >= 9, `expected at least 9 playbooks, found ${skills.length}`);
  for (const s of skills) {
    assert.ok(s.description, `${s.name} has no description`);
    assert.ok(s.keywords.length >= 3, `${s.name} has too few keywords to match on`);
    assert.ok(s.content.length > 400, `${s.name} is too thin to be useful`);
  }
});

test("plain-language requests route to the right playbook", () => {
  // A non-technical owner describes outcomes, not mechanisms.
  const expectations = [
    ["publish a blog post", "everyday-tasks"],
    ["clear the spam comments", "everyday-tasks"],
    ["upload some photos", "everyday-tasks"],
    ["change my homepage", "everyday-tasks"],
    ["my site is broken", "troubleshooting"],
    ["my changes are not showing", "troubleshooting"],
    ["make my site rank better", "seo-audit"],
    ["build an elementor landing page", "page-builders"],
    ["divi theme builder template", "page-builders"],
    ["write gutenberg block markup", "gutenberg"],
    ["build a classic php theme with tailwind", "classic-theme"],
    ["add custom fields the client can edit", "editable-fields"],
    ["connect a new site", "site-setup"],
  ];
  for (const [query, expected] of expectations) {
    const top = matchSkills(query)[0];
    assert.equal(top?.name, expected, `"${query}" matched ${top?.name ?? "nothing"}`);
  }
});

test("matching tolerates plurals", () => {
  // Regression: whole-word matching alone missed "photos" against "photo".
  assert.equal(matchSkills("upload some photos")[0]?.name, "everyday-tasks");
  assert.equal(matchSkills("upload a photo")[0]?.name, "everyday-tasks");
});

test("matching is not fooled by incidental substrings", () => {
  // Regression: substring matching scored "clear the spam comments" against
  // classic-theme, which has nothing to do with comment moderation.
  const top = matchSkills("clear the spam comments")[0];
  assert.notEqual(top?.name, "classic-theme");
});

test("an unrelated query matches nothing rather than guessing", () => {
  assert.equal(matchSkills("qwertyuiop zxcvbnm").length, 0);
});

test("the page-builder playbook names the meta keys that identify each builder", () => {
  // This is the knowledge that stops an agent editing post_content in vain.
  const skill = readSkill("page-builders");
  for (const key of ["_elementor_data", "_et_pb_use_builder", "_fl_builder_data", "_bricks_page_content_2"]) {
    assert.match(skill.content, new RegExp(key), `page-builders should mention ${key}`);
  }
});
