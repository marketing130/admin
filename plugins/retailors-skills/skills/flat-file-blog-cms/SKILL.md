---
name: flat-file-blog-cms
description: Pattern for adding a lightweight, database-free blog to a static HTML website — a JSON index file plus one markdown file per post, rendered entirely client-side with no backend or build step. Reverse-engineered and documented from a real working client site. Use this whenever the user wants to add a blog to a static site, mentions wanting blog posts without a database or CMS backend, wants posts added by just committing files to the repo, or asks for a "simple blog" / "markdown blog" for a site that has no server-side rendering. Distinct from remote-cms-api (which is for a database-backed, remotely-editable-via-dashboard content system) — use this one when the site doesn't need remote editing and posts can be added by whoever has repo access, typically via direct git commits (sometimes from an external automation/webhook rather than manual editing).
---

# Flat-file blog for a static site

A minimal blog pattern with **no database, no backend, no build step** — new
posts are added by committing two files (one JSON entry, one markdown file)
directly to the site's repo. Everything else happens in the browser at
request time. This trades editorial convenience (no remote dashboard, no
scheduled publishing) for near-zero infrastructure: it fits naturally
alongside a static HTML site that has no other backend.

If the client needs to publish posts *without* touching git/a repo — e.g.
from a dashboard or an app-builder platform — this isn't the right pattern;
use the `remote-cms-api` skill's database-backed approach for that instead,
or extend this one by having the client's publishing tool commit the same
two files via the GitHub API rather than a human editing them by hand.

## File structure

```
posts.json                 — index of all posts (array of metadata objects)
posts/
  <slug>.md                — one file per post: frontmatter + markdown body
blog.html                  — listing page (paginated grid, client-rendered)
blog-post.html             — detail page (client-rendered from the .md file)
<slug>.html                — one tiny stub file per post (see "Why the stub
                              files exist" below)
```

## `posts.json` — the index

A flat JSON array, newest posts first by convention (not enforced by code —
whoever adds a post should insert at the top). Each entry:

```json
{
  "title": "Post Title Here",
  "slug": "post-title-here",
  "date": "2026-06-24",
  "excerpt": "One or two sentence summary shown on the listing page.",
  "cover_image": "Media/blog-post-title-here.jpg",
  "category": "Optional Category"
}
```

`category` is optional and inconsistently present in real data — the
reference site has it on newer posts and not on older ones. Any code that
reads it must treat it as possibly-absent (no category filter UI that
assumes every post has one, no `post.category.toLowerCase()` without a
guard). Don't backfill it across old posts unless asked.

`cover_image` can technically be any URL (absolute `https://...` or a
site-relative `Media/...` path) — the rendering code just checks it for
truthiness and drops it into an `<img src>` / CSS `background-image`
either way. But **prefer downloading it into `Media/` and using the local
path**, even when the source is a remote URL (e.g. from an external
publishing tool — see "Featured images" below). Don't leave it pointing at
external storage unless asked to.

`slug` must exactly match the corresponding `posts/<slug>.md` filename (no
`.md` extension in the JSON value) and the stub file's name (`<slug>.html`).
There's no validation enforcing this consistency anywhere in the rendering
code — a mismatch just produces a broken link/404, not an error at publish
time. If building tooling to add posts programmatically, validate this
yourself before writing.

## `posts/<slug>.md` — one file per post

Simple frontmatter block, not real YAML — just `key: value` lines split on
the first colon, with a leading/trailing quote stripped from the value if
present (see `parseFrontmatter` in `references/blog-post-render.js`). This
means: no multi-line values, no nested structures, and a value containing
its own literal colon (e.g. a URL, which the entries here have) works fine
because splitting only cares about the *first* colon and rejoins the rest —
but don't assume this parser handles anything more complex than the flat
`title`/`slug`/`date`/`excerpt`/`cover_image` fields already in use without
testing it first.

```
---
title: "Post Title Here"
slug: "post-title-here"
date: "2026-06-24"
excerpt: "Same excerpt as in posts.json — kept in sync manually."
cover_image: "Media/blog-post-title-here.jpg"
---
The rest of the file is the post body, in plain markdown. Rendered
client-side with the `marked` library — no server-side markdown
processing happens anywhere.
```

Yes, the metadata is duplicated between `posts.json` and each file's own
frontmatter (title/slug/date/excerpt/cover_image appear in both places).
This is how the reference implementation actually works — the listing page
only ever reads `posts.json`, the detail page only ever reads the
individual `.md` file's frontmatter, and nothing cross-checks them against
each other. Don't "fix" this into a single source of truth unless asked;
it's a real constraint of the pattern (client-rendered, no build step, no
templating), not an oversight — flag it to the user rather than silently
choosing to deduplicate it, since removing the duplication would require a
build step or a runtime join, both of which add complexity this pattern
exists to avoid.

## Rendering

**Listing (`blog.html`)**: on load, `fetch('posts.json')`, paginate
client-side (12/page in the reference build — adjust to taste), render a
card grid linking each post to `/<slug>` (extensionless — see the note on
URL handling below). See `references/blog-listing-render.js` for the full
working script (pagination, empty state, error state included).

**Detail (`blog-post.html`)**: resolves the slug from the URL (checked in
this order: `?slug=` query param, then a `/blog/<slug>` path pattern, then
a generic `/<anything>` root-level catch-all), fetches `posts/<slug>.md`,
parses the frontmatter, updates `document.title` and the meta-description
tag, and renders the markdown body via `marked.parse()`. See
`references/blog-post-render.js` for the full script.

**Important limitation to flag to the client, not silently ship**: `document.title`,
meta description, canonical URL, and `og:*`/`twitter:*` tags (title,
description, url, image) should all be updated per-post via JS on load —
see `references/blog-post-render.js`. But because that update only happens
*after* the page loads, it's invisible to anything that doesn't execute
JS — most social-media link unfurlers and some crawlers see only whatever's
baked into the static HTML's `<head>`, which stays generic/blog-listing-level
for every post. Any JSON-LD structured data has the same problem if it's
only ever set via this same client-side pattern. If per-post social sharing
or rich search results matter to the client, this needs a server-side fix
(e.g. a Cloudflare Worker that reads the matching `.md` frontmatter and
rewrites those tags per request, similar in spirit to the `remote-cms-api`
skill's render pipeline) — don't assume the client-side update is
sufficient SEO without asking.

When setting `og:image`/`twitter:image` from `cover_image`, always resolve
it to an absolute URL first (see `toAbsoluteUrl()` in
`references/blog-post-render.js`) — a site-relative `Media/...` path works
fine for an `<img src>` or CSS `background-image`, but social crawlers
require an absolute URL for the image tag itself.

## Featured images — download to the repo, don't leave them remote

`cover_image` often arrives as a remote URL — an external publishing tool
(a dashboard, an image host, a CMS edge function) usually only gives you a
link to its own storage, not a file. **Download that image into `Media/`
and rewrite `cover_image` to the local path, in both `posts.json` and the
post's own frontmatter**, rather than leaving the site dependent on that
external storage staying reachable indefinitely.

This isn't hypothetical: on the reference site, a signed Supabase Storage
URL for one post's `cover_image` started 404ing (the object had been
deleted upstream) well after publish, silently breaking that post's hero
image and social-share image with no local fallback to fall back to.
Local files in the repo don't expire or get deleted out from under the
site the way a third party's storage bucket can.

Naming convention used on the reference site: `Media/blog-<slug>.jpg`
(prefixed so blog images don't collide with the site's other stock photos
in the same folder).

**How this fits the "external automation" publishing model** (see below):
since posts often arrive via a dashboard/webhook this pattern doesn't
control, localization has to happen as a *follow-up* step, not at publish
time:
- **One-time backfill** for an existing site: run
  `references/localize-cover-images.js` once against the whole `posts.json`.
- **Going forward**: either have the external publishing tool download the
  image itself and commit the local path directly (best, if you control
  that tool), or add `references/localize-images-workflow.yml` as a GitHub
  Actions workflow that runs the same script on every push touching
  `posts.json`/`posts/**.md` and commits the localized result back — this
  is the practical option when the publisher is outside your control.

**Two things in that workflow are load-bearing, not boilerplate.** The
publishing tool can push to `main` *while the job is running* — that's the
whole reason the workflow exists — so it needs (a) a `concurrency` group so
two localize commits are never in flight at once, and (b) a
rebase-and-retry loop around `git push` with `fetch-depth: 0` on checkout so
the rebase always has a common ancestor. A plain `git push` here works in
testing and then loses a race against a real publish. Both are in the
reference file; don't simplify them out.

## Why the stub files exist

`blog.html` links to posts at the extensionless path `/<slug>` (not
`/<slug>.html`). Cloudflare's static-asset serving redirects `.html` URLs
*to* their extensionless form automatically, but not the reverse — so a
literal `/<slug>.html` request (an old bookmark, a shared link, a
direct-typed URL) wouldn't resolve to anything on its own. Each post gets
a matching tiny stub file that just fetches `/blog-post.html` and
`document.write`s the result, so both URL forms work:

```html
<!DOCTYPE html><html><head><meta charset="UTF-8">
<script>
fetch('/blog-post.html').then(r=>r.text()).then(h=>{document.open();document.write(h);document.close()});
</script></head><body></body></html>
```

See `references/stub-page-template.html` for the exact template (with the
favicon/preload tags from the reference build included). This is a real,
if slightly unusual, pattern — reproduce it rather than "simplifying" it
away, since the extensionless URL behavior it works around is a genuine
platform quirk, not a design choice you can skip.

## How new posts actually get added

In the reference build, new posts arrive as **direct git commits** — three
files added/changed in one commit: a new entry prepended to `posts.json`,
a new `posts/<slug>.md`, and a new `<slug>.html` stub. This happens via an
external automation (not something built as part of this pattern — could
be a Zapier flow, another AI tool, or a person editing directly), pushing
straight to the repo, which then goes through whatever normal deploy
pipeline the site already has.

There was also a `/blog-api` proxy route stubbed into that site's
Cloudflare Worker (forwarding to an external `BLOG_API_URL`), but it was
confirmed **dead code** — nothing in `blog.html` or `blog-post.html` ever
calls it; both fetch `posts.json`/`posts/*.md` as plain static files
directly. Don't assume a `/blog-api`-shaped route is load-bearing just
because it exists in a Worker file; verify what the actual rendering code
fetches before building around an unused stub.

If a new client needs posts added *without* someone having git access,
that means building an actual publishing mechanism (a form/dashboard that
commits these same three files via the GitHub API, or a proper database-
backed system per `remote-cms-api`) — this skill only covers the read/
render side and the on-disk file convention, not a publishing UI.

## Reference files

- `references/blog-listing-render.js` — the listing page's fetch/paginate/
  render script, ready to drop into a `<script>` tag.
- `references/blog-post-render.js` — the detail page's slug-resolution/
  fetch/frontmatter-parse/render script.
- `references/stub-page-template.html` — the per-post extensionless-URL
  stub file template.
- `references/post-template.md` — a blank post template matching the
  frontmatter format, to copy per new post.
- `references/localize-cover-images.js` — Node script (18+, no deps) that
  downloads every remote `cover_image` into `Media/` and rewrites
  `posts.json` + the matching post's frontmatter to the local path. Run
  once as a backfill, or on a schedule/CI trigger for ongoing publishing.
- `references/localize-images-workflow.yml` — GitHub Actions workflow
  template that runs the script above automatically whenever
  `posts.json`/`posts/**.md` change, for sites where posts are published
  by external tooling this pattern doesn't control.
