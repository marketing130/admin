---
title: "Post Title Here"
slug: "post-title-here"
date: "2026-01-01"
excerpt: "One or two sentence summary — keep this in sync with the same excerpt in posts.json, they're not linked automatically."
cover_image: "Media/blog-post-title-here.jpg"
---
Post body goes here, in plain markdown. Rendered client-side via `marked` —
standard markdown syntax works (headings, lists, links, bold/italic,
images, code blocks).

## To publish a new post

1. If the featured image only exists as a remote URL (e.g. handed to you
   by an image host or dashboard), download it into `Media/` first — see
   "Featured images" in SKILL.md — and use that local path below, not the
   remote URL.
2. Copy this file to `posts/<slug>.md` (slug = same as the `slug` field
   above, no `.md` in the field value itself).
3. Prepend a matching entry to `posts.json` (see SKILL.md for the exact
   shape — title/slug/date/excerpt/cover_image, same values as above).
4. Copy `stub-page-template.html` to `/<slug>.html` at the site root.
5. Commit all files together (including the downloaded image) and
   push/deploy as normal.
