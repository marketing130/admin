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
What a value should look like depends on the field's `type`:

- **`title` / `body` / `code`** — HTML fragments, not templates. Inserted
  verbatim as the element's inner content, so `<span>`, `<em>`, `<strong>`
  etc. are preserved if the original block has them. Don't include the
  outer tag itself, just what goes inside it. (`code` is raw JSON — see
  "Structured data" below.)
- **`alt_text`** — plain text, not HTML. `<img>` is a void element with no
  inner content, so these blocks are keyed to the element's `alt`
  attribute. Saving one rewrites just that `alt`; nothing else about the
  tag is touched.
- **`image`** — a site-relative path, e.g. `"Media/team-photo.jpg"`, not a
  full URL. Send back the same site-relative form you received in `value`.
  The row's `preview` is the absolute, directly-renderable form of the
  same thing — use `preview` for thumbnails, `value` for saves.
  For an `img-<n>-src` field you *may* also save a full `https://...` URL;
  doing so kicks off automatic localization (see below).
- **`seo.*`** — plain text/URLs. `seo.og_image` is the exception to the
  site-relative rule: it's always stored and returned anchored to the real
  production domain, because it feeds the `og:image`/`twitter:image` tags
  that social and search crawlers fetch directly.

A save purges that page's edge cache immediately, so the change is live
on the next page load.

## Images

Every content `<img>` on an editable page exposes two fields, numbered in
document order starting at 1:

- `block.<slug>.img-<n>-alt` — `category: "Content"`, `type: "alt_text"`.
  The alt text, which is the primary image-SEO attribute.
- `block.<slug>.img-<n>-src` — `category: "Content"`, `type: "image"`. The
  image file itself. `width`/`height`/`loading` stay fixed.

Each row's `label` names the section the image lives in followed by its
current alt text, e.g. `"Service Card Photo — Asphalt Shingle Roofing"`,
so it's identifiable without opening the page.

Each page's hero *photo* — the background image behind the hero heading,
distinct from any `<img>` — is editable as `block.<slug>.hero-image`
(`category: "Content"`, `type: "image"`). Saving it replaces just the URL
inside the element's `style`, leaving any gradient overlay untouched.

`hero-image` and `seo.og_image` are independent: editing one does not
update the other, so change both if they should keep matching.

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

# What the DEPLOYED HTML file says, with no overrides layered on — the
# inverse of GET .../content. Used by the write-back sync to tell whether
# a pushed commit is live yet; also the quickest way to see file-vs-database
# drift for a page.
curl -H "x-api-key: $CMS_API_KEY" https://YOUR-DOMAIN.com/api/cms/pages/about/defaults
```

> **Caveat on `:blockKey`:** block keys are stored slug-prefixed
> (`about.hero-heading`), and the backend matches `block_key` **verbatim** —
> it never combines the URL segment with `:slug`. So the segment has to be
> the full prefixed form to address the row. Use the exact `block_key` from
> `GET .../blocks`. The recommended `PUT .../content` flow sidesteps this
> entirely (it always sends the full `block.<slug>.<key>` field_key), so
> prefer that when scripting saves.

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

<!-- ======================================================================
     Delete the two sections below if these pipelines weren't set up.
     ====================================================================== -->

## Content image auto-localization

Saving an `img-<n>-src` field with a remote `https://...` URL — e.g. from a
dashboard upload that only hands back a storage URL — doesn't leave the
site depending on that URL staying reachable. The image is downloaded into
`Media/` and the saved value is rewritten to the local path automatically.

**Pipeline:** save with a remote URL → database webhook fires → `POST
/api/cms/webhooks/image-src` on this Worker → a `repository_dispatch` to
GitHub → the "Localize CMS content image" Action downloads the image,
commits it as `Media/cms-<slug>-img-<n>.<ext>`, and calls `PUT
.../content` with the local path. That write fires the webhook again, but
the value is already local by then, so it stops there.

The save purges the edge cache immediately as always, but the *image file*
only becomes fetchable once the Action's commit is deployed — expect a
short window where the page has switched to the local path but the file
itself 404s.

**One-time setup**, in addition to the setup section above:

1. `wrangler secret put CMS_WEBHOOK_SECRET` — any long random string,
   different from `CMS_API_KEY`.
2. `wrangler secret put GITHUB_DISPATCH_TOKEN` — a token with write access
   to this repo (classic PAT with `repo`, or a fine-grained PAT with
   `Contents: Read and write`).
3. Add `CMS_API_KEY` as a **GitHub Actions repo secret** too (Settings →
   Secrets and variables → Actions) — the workflow's last step calls back
   into this API. This is the one secret that has to exist in both places.
4. Create a database webhook on the blocks table, events `INSERT` and
   `UPDATE`, HTTP POST to
   `https://YOUR-DOMAIN.com/api/cms/webhooks/image-src`, with the header
   `x-webhook-secret: <the CMS_WEBHOOK_SECRET value>`.

## CMS → HTML write-back

By default a dashboard save lives *only* in the database: the Worker layers
it over the static file at request time, so the repo's `index.html` can say
one thing while the live page says another — and hand-editing that heading
in the file does nothing. Write-back closes that loop: every save is baked
into the actual `.html` file and committed, then the override row is
cleared, so the file goes back to being the single source of truth and
editing the HTML directly works again.

**Pipeline:** save → database webhook → `POST
/api/cms/webhooks/content-sync` → `repository_dispatch` → the "Sync CMS
content into HTML" Action runs `scripts/sync-cms-to-html.js` twice:

1. **apply** — writes each saved value into the markup exactly the way the
   render pipeline would have, then commits and pushes.
2. **finalize** — polls `GET .../defaults` until the *deployed* file
   reports those values, and only then clears the rows.

The split is the point: clear the rows any earlier and the live page
reverts to its pre-edit text for as long as the deploy takes.

**Safety properties worth knowing:**

- A row is only cleared if its value was successfully written into the file
  *and* confirmed live. A block key with no matching `data-cms-id` is
  skipped and its row left alone, so a stale key never silently drops
  content.
- Before clearing, rows are re-read: an edit saved while the job was
  running is left in place for its own follow-up run rather than discarded.
- If the deploy doesn't land within ~10 minutes the job fails with the rows
  intact — the live site is unaffected, and re-running the workflow (with
  the page slug as input) picks up where it left off.

**One-time setup:** everything from the previous section, plus one more
webhook — on **both** the pages and blocks tables (one per table), events
`INSERT`, `UPDATE` and `DELETE`, HTTP POST to
`https://YOUR-DOMAIN.com/api/cms/webhooks/content-sync`, header
`x-webhook-secret: <CMS_WEBHOOK_SECRET>`.

**Clearing drift that already exists:** rows saved before this was set up
don't sync until something touches them again. Re-saving the field in the
dashboard is enough; or run the workflow by hand from the Actions tab with
the page slug, which syncs every override on that page at once.
