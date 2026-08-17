---
name: remote-cms-api
description: Complete, battle-tested pattern for adding a remote content/SEO editing REST API (a lightweight CMS) to a static HTML website hosted on Cloudflare Workers, including editable body copy, image alt text, image file swaps, hero photos, and JSON-LD — plus the two follow-up pipelines that keep it honest (auto-downloading remote images into the repo, and writing dashboard saves back into the .html files). Built, debugged, and extended end-to-end on real client sites, and multi-tenant so one shared backend and one dashboard serve every client. Use this whenever the user wants to edit their website's text, images, or SEO/meta tags remotely without redeploying code, wants a client-facing editing dashboard (including ones built in Lovable, Bolt, or similar app builders), mentions "headless CMS," "CMS-lite," or "content API" for a static site, asks to expose page fields for editing via a REST API, or wants to onboard another client site onto an existing CMS of this shape. Also consult this immediately when debugging a Cloudflare Worker that returns 404s or doesn't seem to run at all for some request paths while normal static pages load fine — a critical wrangler.jsonc misconfiguration that causes exactly this is documented here and is easy to lose hours chasing the wrong cause (WAF rules, DNS, stale deploys) instead.
---

# Remote CMS/SEO editing API for static sites

This packages a working pattern for letting a client edit their static site's
SEO metadata, body copy, and images through a REST API — built for real
Cloudflare Workers + static HTML sites, hit real problems, and got fixed.
Read this whole file before starting; it's organized to save you from
re-discovering the same bugs.

## Architecture at a glance

One Cloudflare Worker (`_worker.js`) per client site does two jobs:

1. **Serves the site.** On a normal page GET, it fetches the static HTML
   asset, checks whether any saved edits exist for that page, and if so
   streams the HTML through `HTMLRewriter` to inject them: page-level SEO meta
   tags (`<title>`, meta description, `og:*`, canonical) and any content block
   marked with a `data-cms-id` attribute. If there are no edits, or the
   backend is unreachable, it serves the static file completely untouched —
   **this must fail open everywhere**, since a marketing site going down
   because a CMS backend hiccupped is unacceptable.
2. **Serves a REST API** under `/api/cms/*` for reading and writing those
   edits: a page picker, a per-page "everything editable" endpoint, a save
   endpoint, and a raw `defaults` endpoint. Gated by a single `x-api-key`
   header.

Behind all the client Workers sits **one shared Supabase Edge Function**
(`cms-api`) and **one database**. It's multi-tenant: an `x-api-key` resolves
to exactly one row in a `clients` table, and every query is scoped to that
client's id. The same function also serves the internal dashboard over a
second path (a user JWT plus a `{client_id, method, path, body}` envelope),
proxying to that client's own site — so one dashboard edits N sites and the
browser never holds any client's API key.

```
Client site Worker  ──x-api-key──►  cms-api edge fn  ──►  cms_pages / cms_blocks
       ▲                                  ▲                 (scoped by client_id)
       │                                  │
   page views                     dashboard (user JWT
   /api/cms/*                     + client_id envelope)
```

The key idea that makes this low-risk to bolt onto an existing site: **the
retrofit is purely additive markup.** Adding `data-cms-id="page-slug.field-
name"` to an existing `<h1>` or `<p>` doesn't change how the page looks or
behaves at all until someone actually edits that field through the API. You
can verify this with `git diff` after retrofitting — it should show only new
attributes, never changed text or restructured tags.

If what's actually being asked for is closer to "a blog with no remote
dashboard, posts added by whoever has repo access" than "let a client edit
existing pages via an API," the `flat-file-blog-cms` skill is a much
lighter-weight fit — no database, no Worker API, no auth to design. The two
compose fine on one site (the blog *listing* page is just another CMS page),
but the posts themselves are not part of this API. Check which one the request
actually needs before defaulting to this one just because it also mentions
"blog" or "content."

## Start here: the checklist that costs real time if skipped

Read every item once before writing code, not just when something breaks.

1. **`wrangler.jsonc` MUST set `"main"` and `"run_worker_first"` explicitly.**
   This is the single most expensive bug to rediscover. Without
   `"assets": {"run_worker_first": true}`, Cloudflare's default behavior is to
   serve any request that matches a static file *directly*, without ever
   invoking your Worker script — for every page that already exists as a file,
   which is most of them. The Worker only runs as a fallback for paths that
   don't match a file. This means the entire render-injection feature can
   silently do nothing (pages still look fine, since they're just the raw
   unprocessed files) while the API returns bare 404s for any path
   Cloudflare's asset router doesn't recognize — indistinguishable at first
   glance from a WAF rule, a DNS problem, or a stale deploy, all of which are
   much harder to fix and easy to chase instead. See
   `references/wrangler-config.md` for the exact config. **If a Worker-based
   API returns unexplained bare 404s (empty body, no `content-type`, just
   `server: cloudflare`) on paths that don't match a static file, check this
   before anything else.**

2. **Don't assume you can get a database admin/service-role key.** If the
   client's backend is managed through a no-code AI app builder (Lovable,
   Bolt, Base44, etc.), that key is very often *intentionally* never exposed
   through any tool or dashboard — by design, since it bypasses all access
   control. Ask early whether the user has direct database dashboard access
   before assuming a service-role-key approach will work. If they don't, the
   fix is the edge-function proxy pattern this skill ships. Losing time here
   comes from trying the direct approach first and discovering the key is
   unobtainable only after the user has already gone looking for it.

3. **A "get everything for this page" endpoint must not hide unrelated data
   behind an unrelated 404.** Page-level SEO fields and content blocks are
   different resources (a block edit shouldn't require an SEO row to exist),
   so **fetch them independently**. A real bug from this pattern: combining
   both into one `GET /pages/:slug` call, where a 404 (no SEO row yet — very
   common, since most edits are to a heading, not the page title) silently
   discarded real, successfully-saved block edits too, because the code only
   looked at the blocks field of a response it never received. The edit was
   genuinely saved in the database the whole time; it just never rendered
   anywhere. Reproduce and confirm storage-side truth directly (curl the
   backend, not just your own API) before trusting what your own read path
   reports.

4. **Don't assume a write endpoint is a true upsert.** Some backends split
   create (POST, errors on duplicate) and update (PATCH/PUT, errors if
   missing) into separate, non-idempotent endpoints. If so, upsert = try the
   update first, fall back to create on failure — never assume one call
   handles both cases. (The bundled edge function *does* offer real upserts at
   `PUT /pages/:slug` and `PUT /blocks/:slug/:key`; the Worker template still
   uses PATCH-then-POST because it also has to work against edge functions
   built by a platform you can't change.)

5. **Check the actual response status on every write, every time.** A
   `fetch()` call that isn't checked for `.ok` will happily let you report
   `"saved"` back to the user even when the backend rejected the write — this
   happened twice in one build, in two different shapes (once from an
   unauthenticated backend call succeeding at the JS level while failing at
   the HTTP level, once from a batch payload where every field silently failed
   a name-matching check and nothing was ever sent anywhere, but the handler
   still fell through to a success response). If accepting a batch
   `{ fields: { key: value } }` payload, explicitly track *why* each entry was
   accepted or skipped, and refuse to report success if literally nothing was
   recognized — return the skip reasons, don't guess silently.

6. **Set `Cache-Control: no-store` on every API JSON response.** Cheap
   insurance against a dashboard client, browser, or intermediary caching a
   stale read right after a fresh write.

7. **Purge your own render-time cache on every save.** If you cache backend
   reads at the edge to avoid hitting storage on every page view (reasonable —
   see the template), a save must invalidate that page's cache entry
   immediately, or the live site won't reflect the edit until the cache
   naturally expires.

8. **Never hardcode a domain for request handling** — derive it from the
   incoming request (`new URL(request.url).origin`) so the same Worker code
   works unmodified across a test subdomain, staging, and production.
   **Except for `og:image`.** See "Why og_image is the one hardcoded domain"
   below; that one field must be anchored to the real production origin.

9. **JSON-formatted fields (e.g. structured data / JSON-LD) need client-side
   validation, not server-side.** The API should just store whatever string
   it's given, verbatim — it's the editing dashboard's job to pretty-print on
   load and run `JSON.parse()` before allowing a save, so a typo doesn't
   silently corrupt the page's structured data (browsers ignore malformed
   JSON-LD rather than erroring, so there's no other safety net).

10. **Deploy the edge function with JWT verification OFF.** The storage path
    is server-to-server and sends no `Authorization` header, so Supabase
    rejects every Worker call with a 401 *before your code runs* unless you
    deploy with `--no-verify-jwt` (or `verify_jwt = false` in `config.toml`).
    The symptom — a uniform 401 from a function you can see is deployed —
    looks exactly like a wrong API key, so it eats an hour if you don't know.

11. **`ON CONFLICT` needs a matching unique index or every write fails with
    42P10.** `.upsert(..., { onConflict: 'client_id,slug' })` compiles to
    `INSERT ... ON CONFLICT (client_id, slug)`, which Postgres only accepts if
    a unique index covers exactly those columns. Run the indexes in
    `references/schema-template.sql` *before* deploying the function.

12. **Confirm which schema shape is actually deployed before migrating.**
    There are two in the wild — an early single-tenant shape (`slug` as bare
    primary key, no `client_id`) and the current multi-tenant one. A repo's
    checked-in `.sql` file can easily be the stale one while the live database
    is the other. `schema-template.sql` has the query that tells you which.

## Choosing storage

Three options, in the order to consider them:

- **Shared Supabase Edge Function proxy (what to use).** One function, one
  database, all clients. It holds the `service_role` key server-side and
  exposes a plain `x-api-key`-gated REST interface; the Worker never touches
  Supabase directly. This also works when the client's Supabase project is
  managed by an app-builder platform that won't hand over a `service_role`
  key. See `references/edge-function-template.ts` — and note that a new client
  needs a *row*, not a new function.
- **Direct Supabase REST (PostgREST) with a `service_role` key** as a
  Cloudflare secret. Simpler if you genuinely have that key and only ever need
  one site. Enable Row Level Security with *no* policies on the content
  tables, so only the service-role key can touch them.
- **Cloudflare KV.** Zero external service — the Worker just needs a KV
  namespace bound in `wrangler.jsonc`. No relational queries, but this feature
  doesn't need any. Good fallback if Supabase access is blocked entirely.

Only `backendRequest()`/`backendUpsert()` in the Worker template change
between these; everything else in that file is identical.

## Onboarding a new client onto the existing CMS

Once the shared edge function exists, a new client site is mostly
configuration, not new backend code. In order:

1. **Add the client row.** `insert into clients (name, website_url,
   cms_api_key) values (...)` with a long random key — see the bottom of
   `references/schema-template.sql`. `website_url` is what the dashboard
   gateway proxies to, so it must be the real live origin.
2. **Copy `_worker.js`** from `references/worker-template.js` into the client
   repo and fill in the six `>>> CUSTOMIZE` markers: backend URL,
   `SITE_ORIGIN`, `GITHUB_REPO`, `KNOWN_PAGES`, `SECTION_CONTEXT_RULES`, and
   the dispatch User-Agent.
3. **Apply `wrangler.jsonc`** from `references/wrangler-config.md` — including
   `run_worker_first` (gotcha #1). A scaffolded site very often has only
   `assets.directory` and no `main` at all, which means no Worker runs.
4. **Set the `CMS_API_KEY` secret** on the Worker to the same value as the
   `clients` row. Until it's set, the API is open to anyone — fine while
   building, never at handover.
5. **Retrofit the markup** with `data-cms-id` (see below), starting with 1–2
   representative pages to nail the convention.
6. **Verify with curl** in the sequence under "Deploy and verify" below.
7. **Optional pipelines:** image auto-localization and CMS → HTML write-back,
   each with its own webhook + Action + secrets. Both are additive and can be
   added later; neither is required for basic editing.
8. **Write the client-facing doc** from `references/cms-api-doc-template.md`.

The dashboard needs no work per client beyond the row in step 1 — it
enumerates clients and calls the gateway with `client_id`.

## The `data-cms-id` convention

Format: `data-cms-id="<page-slug>.<short-name>"`, added directly as an
attribute on the existing element — never wrap it in a new element or change
its structure. Naming pattern for `<short-name>`, derived from the element's
role so a generic label-generator can turn it into something readable (see the
template's `labelForBlock`):

- `hero-heading` / `hero-body` for a page's top hero
- `<section>-title` / `<section>-sub` for a section's heading + intro line
  (derive `<section>` from the section's own `id`/class where one exists)
- `-p1`, `-p2`, ... suffix when a section has multiple body paragraphs
- `cta-heading` / `cta-body` for a closing call-to-action
- `schema` for a `<script type="application/ld+json">` structured-data block —
  same mechanism as any other block, since extraction is just "find the tag
  with this attribute and capture what's between its open and close tags"
- `img-<n>-alt` on each content `<img>`, numbered in document order from 1
- `hero-image` on the element whose `style` carries the hero
  `background-image: url(...)`

Extraction is done with bounded regexes (see `extractBlockDefaults` in the
template) rather than a full HTML parser, and this is a deliberate choice, not
a shortcut: as long as every tagged element is a "leaf" that never nests
another element of the *same tag name* inside itself (true for headings and
paragraphs), a regex with a backreference to the tag name reliably finds the
correct matching close tag even with nested `<span>`/`<em>`/`<strong>` inside.
This is simpler and more predictable in a Workers runtime than accumulating
`HTMLRewriter` events for extraction, and avoids a parsing dependency.

**The one non-obvious line in that function** advances `re.lastIndex` to just
past the matched element's *open tag* rather than past the whole match. A
container that carries a `data-cms-id` itself (a hero `<section>` that also
wraps `hero-heading` and `hero-body`) would otherwise swallow every descendant
key in a single match and hide those fields from the dashboard entirely.
Symptom if you drop it: fields that exist in the markup simply never appear in
`GET .../content`, with no error anywhere.

### Three element shapes, three mechanisms

| Shape | Where the value lives | Field `type` |
|---|---|---|
| Headings, paragraphs, JSON-LD | inner HTML | `title` / `body` / `code` |
| `<img>` | the `alt` attribute (void element — no inner content) | `alt_text` |
| Hero container | the `url(...)` inside its `style` attribute | `image` |

Plus one **derived** field with no markup at all: every `img-<n>-alt` gets a
sibling `img-<n>-src` for swapping the image file itself. The Worker derives
it by suffix in both `getPageContent` and `BlockHandler`, so adding image
swapping required zero HTML changes. Keep it that way — don't "fix" it by
adding a second `data-cms-id`.

### `value` vs `preview`

Every field in `GET .../content` carries both. `value` is what gets sent back
on save; `preview` is what a dashboard renders in a table cell. For `image`
fields they deliberately differ: `value` is a site-relative path
(`Media/foo.jpg`) so a save never has to care which host it was made through,
while `preview` is always an absolute, directly-renderable URL. Use `preview`
for every thumbnail, `value` only for saves.

### Why og_image is the one hardcoded domain

`seo.og_image` feeds the real `og:image`/`twitter:image` tags, which search
engines and social-share crawlers fetch **directly from the production
domain**. So it's anchored to a hardcoded `SITE_ORIGIN` — on read, on save,
and in the `defaults` endpoint — not to `url.origin` like every other image.
Otherwise an edit made through a test subdomain silently publishes a
test-subdomain image URL into live SEO metadata, where nothing on the site
will ever show you it's wrong.

### Scoping the retrofit

**Scope the body-content retrofit deliberately, every time.** SEO meta fields
are near-universal and cheap to expose everywhere. Body content should start
narrow — hero heading/intro, section headings/intros, closing CTA — and
explicitly exclude repeating grid content (service cards, FAQ entries,
testimonials) unless asked. Images are the exception worth doing wholesale:
tagging every content `<img>` is mechanical, and it buys alt-text editing
(real image SEO) plus file swapping in one pass. Leave recurring header/footer
logos untagged — their alt text is fixed brand copy, and tagging them adds one
duplicate row per page for no benefit.

Say the scope out loud to the user rather than silently under- or
over-scoping it.

## Content image auto-localization

Saving an `img-<n>-src` with a remote `https://...` URL — which is all a
dashboard upload feature can usually hand you — must not leave the site
depending on that URL staying reachable forever. This is not hypothetical: on
a reference site a signed Supabase Storage URL 404'd months after publish,
silently breaking that image with no local fallback.

**Pipeline:** save with a remote URL → database webhook on the blocks table →
`POST /api/cms/webhooks/image-src` on the Worker → `repository_dispatch` → the
Action downloads the image, commits it to `Media/cms-<slug>-img-<n>.<ext>`,
and calls `PUT .../content` with the local path.

That last write fires the webhook again — but the value is already local by
then, so the Worker no-ops. **Self-terminating; no `[skip]` marker needed.**

Expect a short window where the page has switched to the local path but the
file itself 404s, until the commit deploys.

Setup: `CMS_WEBHOOK_SECRET` + `GITHUB_DISPATCH_TOKEN` as Worker secrets,
`CMS_API_KEY` as a GitHub Actions secret (the one value that must exist in
both places), and a database webhook on the blocks table (INSERT + UPDATE)
pointing at the route with an `x-webhook-secret` header.

## CMS → HTML write-back

By default a dashboard save lives *only* in the database: the Worker layers it
over the static file at request time, so `index.html` in the repo can say one
thing while the live page says another — and hand-editing that heading in the
file does nothing. That drift is invisible until someone tries it.

Write-back closes the loop. **Pipeline:** save → webhook →
`POST /api/cms/webhooks/content-sync` → `repository_dispatch` → the Action
runs `sync-cms-to-html.js` twice:

1. **apply** — writes each override into the markup exactly the way
   `BlockHandler` / the SEO handlers would have rendered it, then commits and
   pushes.
2. **finalize** — polls `GET .../defaults` until the *deployed* file reports
   those values, and only then clears the rows.

**The two-step split is the whole point.** Clear the rows any earlier and the
live page reverts to its pre-edit text for as long as the deploy takes. Don't
merge the steps.

Safety properties worth preserving if you touch this:

- A row is only cleared if its value was written into the file *and* confirmed
  live. A block key with no matching `data-cms-id` is skipped and its row left
  alone, so a stale key never silently drops content.
- Rows are re-read before clearing: an edit saved while the job ran has a
  different value than the snapshot, so it's left for its own follow-up run.
- If the deploy doesn't land in ~10 minutes the job fails with rows intact —
  the live site is unaffected and the workflow can be re-run by hand.
- Escaping must match `HTMLRewriter` exactly (`&` → `&amp;` etc.), because
  finalize compares what it wrote against what the deployed file parses back
  to. Mismatched escaping shows up as a job that times out waiting for a
  deploy that already landed.
- Loops are cut three ways: DELETE events ignored, a fully-nulled page row
  ignored, and a remote `img-<n>-src` URL ignored so localization's follow-up
  write is what syncs.

Rows saved before this pipeline existed don't sync until something touches
them — re-save the field, or run the workflow by hand with the page slug.

## Step-by-step build process

1. **Survey the existing setup** before assuming anything. Is it already on
   Cloudflare Workers/Pages with a `_worker.js` convention? Check
   `wrangler.jsonc`, `.assetsignore`, and git branches for auto-deploy signs
   (e.g. a `cloudflare/*-autoconfig` branch means a GitHub App connection
   already exists and pushes auto-deploy). Check for `package.json` /
   `node_modules` / a locally available `wrangler` CLI — often absent, which
   means verification has to happen against the real deployed URL with
   `curl`/browser tools, not a local dev server. Don't assume `wrangler dev`
   is available.
2. **Agree the field/block scope** with the user before retrofitting markup.
3. **Retrofit the HTML**, purely additive. Verify with `git diff` that only
   attributes were added — no text, whitespace, or structure changed — before
   moving on. For a large page count this is mechanical enough to parallelize
   across background agents once the convention is nailed down on 1–2
   representative pages first.
4. **Decide storage** (see above) based on what credentials are actually
   obtainable — ask, don't assume.
5. **Build the Worker** from `references/worker-template.js`.
6. **Apply the `wrangler.jsonc` config** from `references/wrangler-config.md`.
7. **Write the setup docs** from `references/cms-api-doc-template.md`.
8. **Deploy, then verify with `curl`** (next section).
9. **If there's a client-facing dashboard**, keep it in sync with
   copy-paste-ready prompts rather than assuming the other tool infers the API
   shape correctly — see `references/lovable-prompts.md`.

## Deploy and verify

Verify with `curl` before telling anyone it's ready — not just by eyeballing a
browser. In order:

1. `GET /api/cms/ping` — is the Worker even running, and is auth on?
2. `GET /api/cms/pages` — page picker.
3. `GET /api/cms/pages/<slug>/content` — real current values, no `warning`.
4. `PUT` one real edit.
5. Fetch the actual live page (fresh, not cached) and confirm the change
   rendered.
6. Revert the test edit.

This exact sequence catches the two biggest classes of bug in this pattern
(gotchas #1 and #3) immediately instead of after the client starts using it.

## Reference files

- `references/worker-template.js` — complete, working `_worker.js`. Read fully
  before writing Worker code from scratch; adapt the six CUSTOMIZE markers,
  keep the rest.
- `references/edge-function-template.ts` — the shared multi-tenant Supabase
  Edge Function (storage path + dashboard gateway path).
- `references/schema-template.sql` — tables, the required unique indexes, the
  which-shape-is-deployed query, and the new-client insert.
- `references/wrangler-config.md` — the exact `wrangler.jsonc` fields and why
  each one matters (ties back to gotcha #1).
- `references/dev-vars-example.txt` — every secret the Worker can need, where
  each is set, and which one has to exist in two places.
- `references/sync-cms-to-html.js` + `references/sync-cms-to-html-workflow.yml`
  — the CMS → HTML write-back pipeline.
- `references/localize-cms-image.js` +
  `references/localize-cms-image-workflow.yml` — the content-image
  auto-localization pipeline.
- `references/cms-api-doc-template.md` — a fill-in-the-blanks `CMS-API.md` for
  documenting the finished API to whoever uses it next.
- `references/lovable-prompts.md` — reusable prompt templates for briefing an
  app-builder platform on the exact API contract.
