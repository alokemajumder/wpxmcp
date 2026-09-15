import { test } from "node:test";
import assert from "node:assert/strict";
import { installNodePlatform } from "../dist/platform-node.js";
import { listSkills, matchSkills, readSkill } from "../dist/lib/skills.js";

installNodePlatform();

test("every bundled playbook has the metadata matching depends on", () => {
  const skills = listSkills();
  assert.ok(skills.length >= 19, `expected at least 19 playbooks, found ${skills.length}`);
  for (const s of skills) {
    assert.ok(s.description, `${s.name} has no description`);
    assert.ok(s.keywords.length >= 3, `${s.name} has too few keywords to match on`);
    assert.ok(s.content.length > 400, `${s.name} is too thin to be useful`);
  }
});

test("plain-language requests route to the right playbook", () => {
  // A non-technical owner describes outcomes, not mechanisms.
  const expectations = [
    ["publish a blog post", "content-publishing"], // a dedicated publishing playbook now exists
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

const ROUTES = [
  ["change the separator in yoast settings", "plugin-settings"],
  ["configure the rank math plugin options", "plugin-settings"],
  ["submit the settings form on the plugin admin page", "plugin-settings"],
  ["my site shows a critical error", "site-down"],
  ["there has been a critical error on this website", "site-down"],
  ["white screen after updating a plugin", "site-down"],
  ["the website is down with a 500 error", "site-down"],
  ["stuck in maintenance mode", "site-down"],
  ["I am locked out of wp-admin", "site-down"],
  ["change the header color", "design"],
  ["make the fonts bigger and use our brand colors", "design"],
  ["which plugin is slowing the homepage", "performance"],
  ["the site is really slow", "performance"],
  ["fix meta descriptions", "seo-audit"],
  ["why is my page not showing up on google", "seo-audit"],
  ["find broken links", "seo-audit"],
  ["update stock for product X", "woocommerce"],
  ["refund an order", "woocommerce"],
  ["create a 10% coupon code", "woocommerce"],
  ["turn off comments on old posts", "everyday-tasks"],
  ["fix a typo on the about page", "everyday-tasks"],
  ["add a link to the menu", "everyday-tasks"],
  ["restore the old version of the page", "everyday-tasks"],
  ["hooks on save_post", "wp-developer"],
  ["which plugin registered this rest route", "wp-developer"],
  ["clean up autoloaded options", "wp-developer"],
  ["elementor page text change", "page-builders"],
  ["edit a divi page", "page-builders"],
  ["is my site hacked", "security-hardening"],
  ["run a security audit", "security-hardening"],
  ["go live checklist", "site-launch"],
  ["migrate the site to a new domain", "site-launch"],
  ["switch the site to https", "site-launch"],
  ["write and schedule a blog post for next monday", "content-publishing"],
  ["publish a blog post", "content-publishing"],
  ["add a featured image and categories to the new article", "content-publishing"],
  ["check the site for accessibility problems", "accessibility"],
  ["images are missing alt text for screen readers", "accessibility"],
  ["edit theme.json palette in the block theme", "theme-json"],
  ["reset a template customized in the site editor", "theme-json"],
  ["build a classic php theme with tailwind", "classic-theme"],
  ["which template file renders the single post in my child theme", "classic-theme"],
  ["add custom fields the client can edit", "editable-fields"],
  ["connect a new site", "site-setup"],
  ["401 error with application password", "site-setup"],
  ["monthly maintenance for all client sites", "fleet-maintenance"],
  ["editorial calendar and content inventory", "fleet-maintenance"],
  ["my changes are not showing", "troubleshooting"],
  ["rest_no_route error when calling the api", "troubleshooting"],
  ["write gutenberg block markup", "gutenberg"],
  ["this block contains unexpected or invalid content", "gutenberg"],
  ["my site is broken", "troubleshooting"],
  ["clear the spam comments", "everyday-tasks"],
  ["upload some photos", "everyday-tasks"],
  ["change my homepage", "everyday-tasks"],
  ["make my site rank better", "seo-audit"],
  ["build an elementor landing page", "page-builders"],
  ["divi theme builder template", "page-builders"],
];

test("realistic requests route to exactly one clear playbook", () => {
  // load_skill returns a list of candidates instead of a playbook when the runner-up
  // scores at least 80% of the winner, so a correct but narrow win is still a miss.
  const problems = [];
  for (const [query, expected] of ROUTES) {
    const [top, second] = matchSkills(query);
    if (top?.name !== expected) problems.push(`"${query}" → ${top?.name ?? "nothing"} (expected ${expected})`);
    else if (second && second.score >= top.score * 0.8) problems.push(`"${query}" → ${expected} ${top.score} is too close to ${second.name} ${second.score}`);
  }
  assert.deepEqual(problems, []);
});

test("every playbook is the clear answer to at least one request", () => {
  const covered = new Set(ROUTES.map(([, name]) => name));
  // Playbooks still being written elsewhere; give each a routing case, then remove it here.
  const pending = new Set();
  for (const s of listSkills().filter((s) => s.source === "bundled" && !pending.has(s.name))) {
    assert.ok(covered.has(s.name), `${s.name} has no routing case — add a realistic request for it`);
  }
});

test("matching handles -ies and -es plurals in both directions", () => {
  // Regression: stripping "es" turned "images" into "imag" and "categories" into
  // "categor", so neither matched its singular.
  assert.ok(matchSkills("images").some((s) => s.name === "everyday-tasks" || s.name === "accessibility"));
  assert.ok(matchSkills("add categories").some((s) => s.name === "content-publishing"));
  assert.ok(matchSkills("caches").length > 0);
});
