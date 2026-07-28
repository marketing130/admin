---
name: remote-cms-api
description: Complete, battle-tested pattern for adding a remote content/SEO editing REST API (a lightweight CMS) to a static HTML website hosted on Cloudflare Workers. Built and debugged end-to-end on a real client site. Use this whenever the user wants to edit their website's text or SEO/meta tags remotely without redeploying code, wants a client-facing editing dashboard (including ones built in Lovable, Bolt, or similar app builders), mentions "headless CMS," "CMS-lite," or "content API" for a static site, or asks to expose page fields for editing via a REST API. Also consult this immediately when debugging a Cloudflare Worker that returns 404s or doesn't seem to run at all for some request paths while normal static pages load fine — a critical wrangler.jsonc misconfiguration that causes exactly this is documented here and is easy to lose hours chasing the wrong cause (WAF rules, DNS, stale deploys) instead.
---

# Remote CMS/SEO editing API for static sites

This packages a working pattern for letting a client edit their static site's SEO
metadata and key body copy through a REST API — built for a real Cloudflare
Workers + static HTML site, hit real problems, and got fixed. Read this whole
file before starting; it's organized to save you from re-discovering the same
bugs.

## Architecture at a glance

One Cloudflare Worker (`_worker.js`) does two jobs:

1. **Serves the site.** On a normal page GET, it fetches the static HTML asset,
   checks whether any saved edits exist for that page, and if so streams the
   HTML through `HTMLRewriter` to inject them: page-level SEO meta tags
   (`<title>`, meta description, `og:*`, canonical) and any content block
   marked with a `data-cms-id` attribute. If there are no edits, or the
   backend is unreachable, it serves the static file completely untouched —
   **this must fail open everywhere**, since a marketing site going down
   because a CMS backend hiccupped is unacceptable.
2. **Serves a REST API** under `/api/cms/*` for reading and writing those
   edits: a page picker, a per-page "everything editable" endpoint, and a
   save endpoint. Gated by a single `x-api-key` header.

Both jobs read/write the same storage layer — see "Choosing storage" below.

The key idea that makes this low-risk to bolt onto an existing site: **the
retrofit is purely additive markup.** Adding `data-cms-id="page-slug.field-
name"` to an existing `<h1>` or `<p>` doesn't change how the page looks or
behaves at all until someone actually edits that field through the API. You
can verify this with `git diff` after retrofitting — it should show only new
attributes, never changed text or restructured tags.

If what's actually being asked for is closer to "a blog with no remote
dashboard, posts added by whoever has repo access" than "let a client edit
existing pages via an API," the `flat-file-blog-cms` skill is a much
lighter-weight fit — no database, no Worker API, no auth to design. Check
which one the request actually needs before defaulting to this one just
because it also mentions "blog" or "content."

## Start here: the checklist that costs real time if skipped

Read every item once before writing code, not just when something breaks.

1. **`wrangler.jsonc` MUST set `"main"` and `"run_worker_first"` explicitly.**
   This is the single most expensive bug to rediscover. Without
   `"assets": {"run_worker_first": true}`, Cloudflare's default behavior
   is to serve any request that matches a static file *directly*, without
   ever invoking your Worker script — for every page that already exists as
   a file, which is most of them. The Worker only runs as a fallback for
   paths that don't match a file. This means the entire render-injection
   feature can silently do nothing (pages still look fine, since they're
   just the raw unprocessed files) while the API returns bare 404s for any
   path Cloudflare's asset router doesn't recognize — indistinguishable at
   first glance from a WAF rule, a DNS problem, or a stale deploy, all of
   which are much harder to fix and easy to chase instead. See
   `references/wrangler-config.md` for the exact config. **If a Worker-based
   API returns unexplained bare 404s (empty body, no `content-type`, just
   `server: cloudflare`) on paths that don't match a static file, check this
   before anything else.**

2. **Don't assume you can get a database admin/service-role key.** If the
   client's backend is managed through a no-code AI app builder (Lovable,
   Bolt, Base44, etc.), that key is very often *intentionally* never exposed
   through any tool or dashboard — by design, since it bypasses all access
   control. Ask early whether the user has direct database dashboard access
   before assuming a service-role-key approach will work. If they don't,
   the fix is to have that platform build a small edge function that holds
   the privileged key server-side and exposes a simpler API-key-gated REST
   interface instead — see "Choosing storage" below. Losing time here comes
   from trying the direct approach first and discovering the key is
   unobtainable only after the user has already gone looking for it.

3. **A "get everything for this page" endpoint must not hide unrelated data
   behind an unrelated 404.** If page-level SEO fields and content blocks
   are different resources (which they should be — a block edit shouldn't
   require an SEO row to exist), fetch them independently. A real bug from
   this pattern: combining both into one `GET /pages/:slug` call, where a
   404 (no SEO row yet — very common, since most edits are to a heading, not
   the page title) silently discarded real, successfully-saved block edits
   too, because the code only looked at the blocks field of a response it
   never received. The edit was genuinely saved in the database the whole
   time; it just never rendered anywhere. Reproduce and confirm storage-side
   truth directly (curl the backend, not just your own API) before trusting
   what your own read path reports.

4. **Don't assume a write endpoint is a true upsert.** Some backends split
   create (POST, errors on duplicate) and update (PATCH/PUT, errors if
   missing) into separate, non-idempotent endpoints. If so, upsert = try the
   update first, fall back to create on failure — never assume one call
   handles both cases.

5. **Check the actual response status on every write, every time.** A
   `fetch()` call that isn't `await`ed for `.ok` will happily let you report
   `"saved"` back to the user even when the backend rejected the write —
   this happened twice in one build, in two different shapes (once from an
   unauthenticated backend call succeeding at the JS level while failing at
   the HTTP level, once from a batch payload where every field silently
   failed a name-matching check and nothing was ever sent anywhere, but the
   handler still fell through to a success response). If accepting a batch
   `{ fields: { key: value } }` payload, explicitly track *why* each entry
   was accepted or skipped, and refuse to report success if literally
   nothing was recognized — return the skip reasons, don't guess silently.

6. **Set `Cache-Control: no-store` on every API JSON response.** Cheap
   insurance against a dashboard client, browser, or intermediary caching a
   stale read right after a fresh write.

7. **Purge your own render-time cache on every save.** If you cache backend
   reads at the edge to avoid hitting storage on every page view (reasonable
   — see the template), a save must invalidate that page's cache entry
   immediately, or the live site won't reflect the edit until the cache
   naturally expires.

8. **Never hardcode a domain.** Derive it from the incoming request
   (`new URL(request.url).origin`) so the same Worker code works unmodified
   across a test subdomain, staging, and production.

9. **JSON-formatted fields (e.g. structured data / JSON-LD) need
   client-side validation, not server-side.** The API should just store
   whatever string it's given, verbatim — it's the editing dashboard's job
   to pretty-print on load and run `JSON.parse()` before allowing a save,
   so a typo doesn't silently corrupt the page's structured data (browsers
   ignore malformed JSON-LD rather than erroring, so there's no other
   safety net).

## Choosing storage

Three options, in the order to consider them:

- **Supabase Edge Function proxy (most broadly reusable).** If there's any
  chance the client's Supabase project is managed by an app-builder platform
  that won't hand over a `service_role` key, have that platform build a
  small edge function that holds the key server-side and exposes a plain
  `x-api-key`-gated REST interface over the content tables instead. The
  Worker never touches Supabase directly. This is what actually worked on
  the reference build. Probe the edge function's exact behavior with `curl`
  before writing Worker code against it — don't assume its write semantics
  (see gotcha #4) or response shapes match what you'd expect from raw
  PostgREST.
- **Direct Supabase REST (PostgREST) with a `service_role` key** as a
  Cloudflare secret. Simpler if you genuinely have that key. Enable Row
  Level Security with *no* policies on the content tables, so only the
  service-role key can touch them — the anon/public key gets nothing.
- **Cloudflare KV.** Zero external service, nothing to fetch a key for at
  all — the Worker just needs a KV namespace bound in `wrangler.jsonc`. No
  relational queries, but this feature doesn't need any. Good fallback if
  Supabase access is blocked entirely and there's no app-builder platform
  to proxy through either.

See `references/worker-template.js` for a complete, working implementation
using the edge-function-proxy pattern (adapt the `backendRequest`/
`backendUpsert` functions if using a different storage choice — everything
else in the file stays the same).

## The `data-cms-id` convention

Format: `data-cms-id="<page-slug>.<short-name>"`, added directly as an
attribute on the existing element — never wrap it in a new element or change
its structure. Naming pattern for `<short-name>`, derived from the element's
role so a generic label-generator can turn it into something readable (see
the template's `labelForBlock`):

- `hero-heading` / `hero-body` for a page's top hero
- `<section>-title` / `<section>-sub` for a section's heading + intro line
  (derive `<section>` from the section's own `id`/class where one exists)
- `-p1`, `-p2`, ... suffix when a section has multiple body paragraphs
  instead of one
- `cta-heading` / `cta-body` for a closing call-to-action
- `schema` for a `<script type="application/ld+json">` structured-data block
  — this works with the exact same mechanism as any other block, since the
  extraction is just "find the tag with this attribute and capture what's
  between its open and close tags," regardless of tag name

Extraction is done with a bounded regex (see `extractBlockDefaults` in the
template) rather than a full HTML parser, and this is a deliberate choice,
not a shortcut: as long as every tagged element is a "leaf" that never nests
another element of the *same tag name* inside itself (true for headings and
paragraphs; a `<p>` doesn't contain another `<p>`), a regex with a
backreference to the tag name reliably finds the correct matching close tag
even with nested `<span>`/`<em>`/`<strong>` inside. This is simpler and more
predictable in a Workers runtime than accumulating `HTMLRewriter` events for
extraction, and avoids adding a parsing dependency.

**Scope the body-content retrofit deliberately, every time.** SEO meta
fields are near-universal and cheap to expose everywhere. Body content
should start narrow — hero heading/intro, section headings/intros, closing
CTA — and explicitly exclude repeating grid content (service cards, FAQ
entries, testimonials, gallery captions) and per-item images unless asked.
This is what keeps a retrofit tractable across dozens of pages instead of
turning into an unbounded project; say so explicitly to the user rather than
silently under- or over-scoping.

## Step-by-step build process

1. **Survey the existing setup** before assuming anything. Is it already on
   Cloudflare Workers/Pages with a `_worker.js` convention? Check
   `wrangler.jsonc`, `.assetsignore`, and git branches for auto-deploy
   integration signs (e.g. a `cloudflare/*-autoconfig` branch means a GitHub
   App connection already exists and pushes auto-deploy). Check for
   `package.json` / `node_modules` / a locally available `wrangler` CLI —
   often absent, which means verification has to happen against the real
   deployed URL with `curl`/browser tools, not a local dev server. Don't
   assume `wrangler dev` is available.
2. **Agree the field/block scope** with the user before retrofitting markup
   — which pages, which fields, how much body content (see scoping guidance
   above).
3. **Retrofit the HTML**, purely additive. Verify with `git diff` that only
   attributes were added — no text, whitespace, or structure changed —
   before moving on. For a large page count, this is mechanical enough to
   parallelize across background agents once the convention is nailed down
   on 1-2 representative pages first.
4. **Decide storage** (see above) based on what credentials are actually
   obtainable — ask, don't assume, and plan for the edge-function pattern
   from the start if there's any doubt.
5. **Build the Worker** from `references/worker-template.js` — the render-
   injection pipeline plus the REST API. Adapt the storage-calling functions
   to whatever was chosen in step 4; the rest of the file is reusable as-is.
6. **Apply the `wrangler.jsonc` config** from `references/wrangler-config.md`.
7. **Write the setup docs** from `references/cms-api-doc-template.md` — a
   `CMS-API.md`-style reference with real curl examples and setup steps for
   whichever storage backend was chosen.
8. **Deploy, then verify with `curl` before telling the client it's ready** —
   not just eyeballing a browser. In order: hit a health-check endpoint,
   `GET` a real page's content, `PUT` a real edit, confirm it shows up both
   via the API and on the actual live rendered page (a fresh fetch, not a
   cached one), then revert the test edit. This exact sequence catches both
   of the two biggest classes of bug in this pattern (gotchas #1 and #3)
   immediately instead of after the client starts using it.
9. **If there's a client-facing dashboard** (Lovable or similar), keep it in
   sync with copy-paste-ready prompts rather than assuming the other tool
   infers the API shape correctly — see `references/lovable-prompts.md` for
   templates covering the page-picker/table/edit-dialog flow, JSON/code
   field handling, and a tabbed SEO/Content/Structured-Data layout. Be
   explicit in every such prompt about the exact `field_key` format,
   `category`/`type` meanings, and request/response JSON shapes — don't
   assume the other tool can infer them from a vague description.

## Reference files

- `references/worker-template.js` — complete, working `_worker.js`
  (edge-function-proxy storage variant). Read this fully before writing
  Worker code from scratch; adapt the page list and storage functions,
  keep the rest.
- `references/wrangler-config.md` — the exact `wrangler.jsonc` fields
  and why each one matters (ties back to gotcha #1).
- `references/schema-template.sql` — Supabase table schema (for the direct
  or edge-function-proxied Supabase options).
- `references/cms-api-doc-template.md` — a fill-in-the-blanks `CMS-API.md`
  for documenting the finished API to whoever uses it next (the client,
  a dashboard builder, or future-you).
- `references/lovable-prompts.md` — reusable prompt templates for briefing
  an app-builder platform (Lovable, etc.) on the exact API contract so its
  generated dashboard doesn't have to be reverse-engineered against.
