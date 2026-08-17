---
description: Stand up the blog + remote CMS on a client's static site, end to end
argument-hint: "[blog | cms | both] (defaults to both)"
---

Onboard this client site onto our standard content stack: the flat-file blog
and/or the remote CMS/SEO editing API.

Scope requested: **$ARGUMENTS** (if empty, treat it as `both`).

Load the matching skills before doing anything else — `flat-file-blog-cms`
for the blog, `remote-cms-api` for the CMS — and follow them. They carry the
gotchas that cost real hours; this command is only the running order.

## Phase 0 — Survey, don't assume

Report what you find before writing anything:

- Hosting shape: is there a `wrangler.jsonc`? Does it set `main` and
  `assets.run_worker_first`? A scaffolded site usually has neither, which
  means **no Worker runs at all** — this is gotcha #1 in `remote-cms-api`
  and it silently breaks the entire CMS.
- Is there an existing `_worker.js` with routes already in it that must be
  preserved?
- Deploy path: git auto-deploy (look for a `cloudflare/*-autoconfig` branch)
  or manual `wrangler deploy`? Is `wrangler` even available locally? Often
  it isn't, which means verification has to happen against the real deployed
  URL with `curl`, not a local dev server.
- Page inventory: every real content page (`<slug>.html`), for `KNOWN_PAGES`.
- Image folder convention (`Media/`?) and whether images exist yet.
- The production domain, and whether a test subdomain is in play.

Then **state the plan and the scope you're about to implement**, and get
confirmation before touching markup. Under-scoping and over-scoping the
`data-cms-id` retrofit are both expensive to undo.

## Phase 1 — Blog (skip if scope is `cms`)

Per `flat-file-blog-cms`:

1. `posts.json`, `posts/`, `blog.html` (listing), `blog-post.html` (detail),
   one `<slug>.html` stub per post.
2. Wire the render scripts from that skill's references into the two pages,
   restyled to this client's actual CSS classes — not the reference markup.
3. `scripts/localize-cover-images.js` + the localize workflow, with the
   concurrency group and rebase-retry loop intact.
4. Flag the per-post SEO limitation to the user explicitly: client-side
   `<head>` updates are invisible to social unfurlers. Don't ship it as if
   it were solved.

## Phase 2 — CMS (skip if scope is `blog`)

Per `remote-cms-api`, in this order:

1. **Client row** in the shared CMS database — `name`, `website_url`,
   `cms_api_key` (long random). See the bottom of that skill's
   `references/schema-template.sql`. Ask the user to run it if you don't
   have database access; do not invent a key and assume it's registered.
2. **`_worker.js`** from `references/worker-template.js`, with all six
   `>>> CUSTOMIZE` markers filled in. Preserve any pre-existing routes.
3. **`wrangler.jsonc`** from `references/wrangler-config.md`.
4. **`.dev.vars.example`** from `references/dev-vars-example.txt`, and
   `.dev.vars` added to `.gitignore`.
5. **Markup retrofit.** Do 1–2 representative pages first, confirm the
   convention with `git diff` (attributes added, nothing else changed), then
   roll out. Only after the convention is settled is this safe to
   parallelize across agents.
6. **Secrets:** `CMS_API_KEY` on the Worker. Tell the user the API is open
   to the world until they set it.
7. **Client-facing doc** from `references/cms-api-doc-template.md`, saved as
   `CMS-API.md` in the repo.

## Phase 3 — Optional pipelines

Only if the user wants them; both are additive and can come later. Say what
each buys and what it costs to set up:

- **Image auto-localization** — uploaded images stop depending on external
  storage. Needs `CMS_WEBHOOK_SECRET` + `GITHUB_DISPATCH_TOKEN` Worker
  secrets, a `CMS_API_KEY` Actions secret, and one database webhook.
- **CMS → HTML write-back** — dashboard saves get baked into the repo's
  `.html` files so the files stay the source of truth and stay
  hand-editable. Without it, editing a heading in the repo silently does
  nothing on a page that's been edited through the dashboard. Needs the same
  secrets plus two more webhooks.

## Phase 4 — Verify, then report

Never report "ready" from eyeballing a browser. Run the curl sequence from
the skill: `ping` → `pages` → `content` → a real `PUT` → confirm it rendered
on a fresh fetch of the live page → revert the test edit.

Then report: what's editable, what's deliberately out of scope, which
secrets are set vs still pending, and anything the user has to do by hand
(database rows, webhooks, tokens).
