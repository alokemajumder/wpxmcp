---
name: everyday-tasks
title: Everyday site management for a non-technical owner
description: How to carry out the things a site owner actually asks for — publishing, menus, homepage, images, comments, updates — safely and in plain language.
keywords: publish, post, blog, page, menu, homepage, image, photo, comment, spam, update, plugin, backup, change, edit, add, remove, launch, website, owner, client, beginner, picture, upload, publish post, new page, navigation, front page, moderate
---

## Who this is for

The person asking is the site's owner, not a developer. They will describe outcomes ("put the new prices up", "the contact page is wrong") rather than mechanisms. Your job is to translate that into the right operations, do them safely, and report back in their language.

## How to work with them

**Confirm what they mean before writing.** "The pricing page" might be `/pricing/`, a section of the homepage, or a page they forgot exists. Use `find_content_by_url` if they give a link, `get_content_by_slug` or `search_site` if they give a name, and **say which page you found** before changing it.

**Show, then change.** For anything user-visible, read the current value back to them first: "Right now it says *Pro — $39/month*. Change that to $49?" One sentence, and it prevents most mistakes.

**Draft by default, publish on request.** `create_content` creates drafts deliberately. Offer the draft link and let them look before it goes live. Only pass `status: "publish"` when they have said to publish.

**Explain in their terms.** Not "I set `comment_status` to `closed` on 14 posts" but "I turned off comments on the 14 posts in the News category." Mention the technical name only if they will need it later.

**Say what you cannot see.** If a caching plugin might be hiding a change, say so and check with `get_page_html` rather than claiming success.

## The tasks that come up most

### Publish a post or page
```
create_content  type: "post", title, content        → a draft
get_content_summary                                  → read it back to them
update_content  id, status: "publish"                → only when they say so
```
Content is Gutenberg block markup — load the `gutenberg` skill before writing any. Offer to add a featured image; posts without one look unfinished in most themes.

### Change wording on an existing page
```
find_content_by_url  url                             → confirm which page
get_content          id                              → read the current wording
update_content       id, edits: [{find, replace}]    → change only that phrase
get_page_html        url, mode: "summary"            → confirm it is live
```
Always use `edits`, never resend the whole page. If the edit reports "does not appear", the wording differs from what they told you — ask, do not guess.

### Add something to the navigation menu
```
list_menus                                           → which menu, which location
add_menu_item  menu_id, title, type: "post_type", object: "page", object_id
```
If `list_menus` is empty the theme is probably a block theme, where navigation lives in a template — say so rather than creating a menu nothing displays.

### Change the homepage
```
get_site_settings                                    → show_on_front, page_on_front
update_site_settings  show_on_front: "page", page_on_front: <id>
```
This changes what every visitor sees first. Confirm before doing it, and check the result.

### Add images
```
create_media  file_path or url, alt_text             → always write alt text
update_content  id, featured_media: <attachment id>
```
Alt text is not optional: it is what a blind visitor hears and what search engines read. Write a real description ("a red bicycle against a brick wall"), never "image" or the filename.

### Clear the comment queue
```
list_comments  status: "hold"                        → what is waiting
moderate_comments  ids, action: "approve" | "spam"
```
Summarise before acting: "12 waiting — 9 look like genuine questions, 3 are spam link-drops. Approve the 9?"

### Tidy up SEO
```
audit_content  type: "post"                          → what is actually missing
```
Fix the highest-impact items first: missing titles, missing meta descriptions on pages that get traffic, missing alt text. Load the `seo-audit` skill for the per-plugin field names.

### Update plugins
Updates fix security holes, and occasionally break things. Before updating anything on a live site:
1. `list_plugins` — show what is out of date.
2. Ask whether they have a backup or a staging copy. If not, **say plainly that an update can break the site and there is no undo from here.**
3. Update one at a time, checking `get_page_html` after each.

Never bulk-update a live site without that conversation.

## Things to refuse gently

Some requests are reasonable but need a human decision. Do the safe part, explain the rest:

- **"Delete all the old posts"** — show what matches first, trash rather than destroy, and let them confirm the list.
- **"Make it look like [another site]"** — copying a design is a real project, not a tool call. Offer to build a theme, and load the `design` and `classic-theme` skills.
- **"Fix my site, it's broken"** — diagnose before touching anything: `test_site`, then `site_info`, then the `troubleshooting` skill. Report what is wrong before proposing a fix.
- **Anything on a live site with no backup** — say so once, clearly, then proceed if they still want it. It is their site.

## What "like a pro" actually means here

A professional would: check before changing, change the smallest thing that works, verify on the front end, and leave the site editable by whoever comes next. Registering fields with `register_fields` as you build, writing real alt text, and keeping content in the database rather than hardcoded in templates are what make the difference six months later.
