# Remote content & SEO API

Fill-in-the-blanks template for documenting the finished API for a specific
client site. Replace `YOUR-DOMAIN.com` throughout, adjust the storage
paragraph to match what was actually chosen, and fill in "What's editable
today" with the real page/field list once the retrofit is done. This is the
artifact you leave behind for the client, a dashboard builder (Lovable/etc.),
or future-you.

---

A REST API for editing page SEO tags and key body-copy blocks on the live
site without touching HTML files. Implemented in `_worker.js`.

<!-- Adjust this paragraph to match the storage choice actually made —
see SKILL.md "Choosing storage" for the three options. Example for the
edge-function-proxy variant: -->
Storage is a Supabase Edge Function that holds the Supabase `service_role`
key server-side and exposes a simpler `x-api-key`-gated REST interface over
the `cms_pages`/`cms_blocks` tables. This Worker only ever needs
`CMS_API_KEY` — it never sees or stores a Supabase key itself, and that
same `CMS_API_KEY` both gates incoming requests to this API *and* is sent
on to the edge function.

Nothing on the site changes until you write through this API — pages render
exactly as their static HTML until a matching backend row exists, and any
backend outage fails open (the static page is served as-is).

## One-time setup

1. Pick a value for `CMS_API_KEY` (any long random string).
2. Set it as a Cloudflare secret — from a machine with `wrangler` installed
   and logged in: `wrangler secret put CMS_API_KEY`. Or via the Cloudflare
   dashboard: Workers & Pages → this project → Settings → Variables and
   Secrets.
3. Set up the storage backend (Supabase table migration / edge function /
   KV namespace — whichever was chosen).
4. `wrangler deploy` (or just push to `main` if auto-deploy is already
   connected).
5. Verify: `curl https://YOUR-DOMAIN.com/api/cms/ping` should return
   `"secretsConfigured": true` (or equivalent) once everything above is
   done.

## Auth

Every request below needs:
```
x-api-key: <your CMS_API_KEY value>
```
Missing or wrong key → `401 Unauthorized`. (If `CMS_API_KEY` isn't set as a
secret yet, the API is open with no key required — useful for initial
testing only. Lock it down before real use.)

## Page picker

```bash
curl -H "x-api-key: $CMS_API_KEY" \
  https://YOUR-DOMAIN.com/api/cms/pages
```
Returns the fixed list of editable pages as
`[{ "slug": "about", "label": "About" }, ...]`. The page slug is the
filename without `.html` — `about.html` is `about`, the homepage
(`index.html`) is `index`.

## Editing a page (recommended flow)

Built for a "pick a page → table of editable fields → click one to edit
in a dialog → save" dashboard:

1. `GET /api/cms/pages` → page picker (slug + label).
2. On selection, `GET /api/cms/pages/:slug/content` → a flat, table-ready
   list of every editable field on that page, reading the page's **actual
   current live HTML** and layering any previously-saved edit on top. So
   this always returns the true current value — never blank just because
   a field hasn't been edited yet.
3. Render one table row per item in `fields`: `category` ("SEO" or
   "Content") and `type` ("title" / "body" / "image" / "link" / "code")
   for grouping/icons, `label` for the row name, `preview` (plain text,
   truncated) for the table cell.
4. Clicking a row's edit button opens a dialog pre-filled with that
   field's full `value` (an HTML fragment for Content rows, plain text
   for SEO rows, raw JSON text for "code" rows — see the note on structured
   data below).
5. Saving calls `PUT /api/cms/pages/:slug/content` with just that one
   field (or several, if batching) keyed by its exact `field_key`.

```bash
curl -H "x-api-key: $CMS_API_KEY" \
  https://YOUR-DOMAIN.com/api/cms/pages/about/content
```
```json
{
  "slug": "about",
  "fields": [
    {
      "field_key": "seo.title",
      "category": "SEO",
      "type": "title",
      "label": "Page Title",
      "value": "About Us | Example Co",
      "preview": "About Us | Example Co"
    },
    {
      "field_key": "block.about.hero-heading",
      "category": "Content",
      "type": "title",
      "label": "Hero Heading",
      "value": "About <span>Example Co</span>",
      "preview": "About Example Co"
    }
  ]
}
```

`PUT /api/cms/pages/:slug/content` saves whichever fields you include —
keyed by the exact `field_key` from the GET response. Send just the one
field the user edited, or several at once; everything else is left as-is.

```bash
curl -X PUT -H "x-api-key: $CMS_API_KEY" -H "Content-Type: application/json" \
  https://YOUR-DOMAIN.com/api/cms/pages/about/content \
  -d '{
    "fields": {
      "block.about.hero-heading": "About <span>Example Co</span> — Reimagined"
    }
  }'
```
Values for `block.*` fields are HTML fragments, not templates — inserted
verbatim as the element's inner content, so `<span>`, `<em>`, `<strong>`
etc. are preserved if the original block has them. Don't include the
outer tag itself, just what goes inside it. Values for `seo.*` fields are
plain text/URLs.

A save purges that page's edge cache immediately, so the change is live
on the next page load.

## Structured data (JSON-LD)

If any page's `<script type="application/ld+json">` block was tagged with
`data-cms-id`, it appears as a `block.<slug>.schema` field with
`category: "SEO"` and `type: "code"`. Its `value` is raw JSON text, not an
HTML fragment — a dashboard editing this field should pretty-print it on
load and validate with `JSON.parse()` before allowing a save, since the API
stores whatever string it receives verbatim and malformed JSON-LD fails
silently (browsers just ignore it) rather than erroring anywhere visible.

## Lower-level endpoints

These operate on raw backend rows only (no live-HTML extraction/merge — a
never-edited field/block returns `null` rather than its real static value).
Useful for debugging or reverting a single block.

```bash
# Raw SEO override row for a page
curl -H "x-api-key: $CMS_API_KEY" https://YOUR-DOMAIN.com/api/cms/pages/about
curl -X PUT -H "x-api-key: $CMS_API_KEY" -H "Content-Type: application/json" \
  https://YOUR-DOMAIN.com/api/cms/pages/about -d '{"title": "..."}'

# Raw block overrides for a page
curl -H "x-api-key: $CMS_API_KEY" https://YOUR-DOMAIN.com/api/cms/pages/about/blocks
curl -H "x-api-key: $CMS_API_KEY" https://YOUR-DOMAIN.com/api/cms/pages/about/blocks/hero-heading
curl -X PUT -H "x-api-key: $CMS_API_KEY" -H "Content-Type: application/json" \
  https://YOUR-DOMAIN.com/api/cms/pages/about/blocks/hero-heading -d '{"html": "..."}'

# Revert one block back to the static default
curl -X DELETE -H "x-api-key: $CMS_API_KEY" \
  https://YOUR-DOMAIN.com/api/cms/pages/about/blocks/hero-heading
```

## Caching

The render pipeline (what visitors see) caches backend overrides at the
edge for up to 60 seconds per page — but saving through `PUT .../content`
(or the lower-level PUT/DELETE endpoints) purges that page's cache
immediately, so edits show up on the next load either way.

## What's editable today

<!-- Fill in with the real scope agreed with the client. Example: -->
SEO fields on every real content page, plus the hero heading/intro and
each major section's heading/intro paragraph and the closing CTA banner,
plus each page's structured-data block. Repeating grid items (service
cards, testimonials, FAQ entries, gallery captions) are not marked up —
the mechanism is generic, so adding `data-cms-id` to more elements later
is a small, additive change, not a redesign.

<!-- Note any content with its own separate pipeline that's explicitly
out of scope (e.g. a blog with its own markdown/JSON files), if relevant. -->
