# Kickoff prompts for a new client site

Paste-ready prompts for standing up the blog and CMS on a new site. Fill in
the bracketed values and delete any line that doesn't apply — a blank left
in place reads as a real answer and gets acted on.

Run these from **inside the client's repo**, with the skills already copied
in (see `../INSTALL.md`). If you'd rather not paste a wall of text, the
`/cms-onboard` command does the same thing and asks you for the details as
it goes; these prompts exist for when you already know the answers and want
one round trip instead of five.

---

## 1. Full stack — blog + CMS

```
Set up our standard content stack on this site: the flat-file blog and the
remote CMS/SEO editing API. Use the flat-file-blog-cms and remote-cms-api
skills — read both fully before writing anything, and follow them rather
than improvising; they carry the gotchas that have cost us real hours.

The site
- Client: [CLIENT NAME]
- Production domain: [https://example.com]
- Test/staging domain, if any: [https://test.example.com — or "none"]
- GitHub repo: [org/repo]
- Deploys via: [Cloudflare git auto-deploy on push to main / manual wrangler deploy]
- Image folder: [Media/]

The backend
- Use the existing shared cms-api edge function and database — do NOT build
  a new backend or new tables.
- Edge function URL: [https://PROJECT.supabase.co/functions/v1/cms-api]
- Client row in `clients`: [already created, cms_api_key is set / needs
  creating — give me the SQL and I'll run it]
- I [do / do not] have Supabase SQL editor access for this project.

Scope
- Editable pages: [every .html page at the repo root / list them]
- Body content to expose: hero heading + intro, each section's heading and
  intro paragraph, and the closing CTA. Not repeating grid items (service
  cards, FAQ entries, testimonials) unless you flag a good reason.
- Images: tag every content <img> for alt text + file swapping, and each
  page's hero background photo. Leave the header/footer logo untagged.
- Structured data: [yes, expose the JSON-LD block / no JSON-LD on this site]
- Blog: [needed, starting empty / needed, migrating [N] existing posts from
  [source] / not needed — skip the blog entirely]

How I want you to work
- Survey the repo first and tell me what you found before changing anything,
  especially whether wrangler.jsonc sets `main` and `assets.run_worker_first`.
- Do 1-2 representative pages first and show me the diff so I can confirm
  the data-cms-id convention before you roll it out everywhere.
- The markup retrofit must be purely additive — attributes only, no text,
  whitespace, or structure changes. Prove it with git diff.
- Don't change the visual design, copy, or layout anywhere.
- Verify with curl against the deployed URL before telling me it's ready:
  ping, pages, content, a real PUT, confirm it rendered live, revert.
- At the end, list exactly what I have to do by hand — database rows,
  secrets, webhooks, tokens — and what's still open.

Skip the optional pipelines (image auto-localization, CMS -> HTML
write-back) for now; I'll ask for those separately once this is working.
```

---

## 2. Blog only

For a site that needs posts but no dashboard editing of the existing pages.
This is the most common starting point — the page/SEO CMS can be added later
without redoing any of it.

```
Add our standard flat-file blog to this site using the flat-file-blog-cms
skill. Read it fully before writing anything and follow it — including the
parts that look odd, like the per-post stub .html files and the
concurrency/rebase-retry handling in the localize workflow. Both work around
real platform behavior we've already been bitten by; don't simplify them out.

The site
- Client: [CLIENT NAME]
- Production domain: [https://example.com]
- GitHub repo: [org/repo]
- Deploys via: [Cloudflare git auto-deploy on push to main / manual wrangler deploy]
- Image folder: [Media/]
- Pages I want the blog linked from: [main nav / footer / both / nowhere yet]

Content
- Existing posts to migrate: [none, start empty / [N] posts from [source —
  e.g. an old WordPress export, another site, a CSV]]
- Posts will be published by: [an external dashboard that pushes posts.json
  and posts/*.md straight to git / us committing by hand]
- Posts per page on the listing: [12]
- Categories: [not needed / yes, and here are the ones to use: ...]

Build
- posts.json, posts/, blog.html (listing), blog-post.html (detail), and one
  stub .html per post.
- scripts/localize-cover-images.js plus the GitHub Actions workflow, so a
  remotely-hosted cover image gets pulled into the repo instead of leaving
  the site dependent on someone else's storage staying up.
- Match the site's existing CSS classes, type scale, and layout. Don't
  introduce new visual styling, don't pull in a CSS framework, and don't
  touch any existing page beyond adding the nav/footer link.

How I want you to work
- Survey the repo first and tell me what you found before changing anything.
- Build the listing and one real post end to end, then show me before doing
  the rest — I want to see the card grid and a rendered post against the
  real design.
- If posts are being migrated, tell me up front what won't survive the
  conversion (inline HTML, shortcodes, embeds, image references) instead of
  silently dropping it.
- Verify by actually loading the blog listing and at least two post URLs —
  both /<slug> and /<slug>.html, since those resolve differently — not just
  by checking that the files exist.

Flag the per-post SEO limitation to me explicitly rather than shipping it
silently: the <head> updates happen client-side, so social unfurlers and
some crawlers see only the generic static tags. Tell me what it would take
to fix properly, and I'll decide whether this client cares about link
previews enough to pay for it.

At the end, tell me exactly how a new post gets added — the files, the
format, and who does it — in terms I can forward to the client.
```

---

## 3. Adding the optional pipelines later

Once basic editing works and the client is actually using it.

```
Add the two follow-up pipelines from the remote-cms-api skill to this site:

1. Content image auto-localization — so images uploaded through the
   dashboard get downloaded into the repo instead of leaving the site
   dependent on external storage.
2. CMS -> HTML write-back — so dashboard saves get baked into the .html
   files and the repo stays the source of truth and stays hand-editable.

GitHub repo for repository_dispatch: [org/repo]

Copy the scripts and workflows from the skill's references rather than
writing new ones, and keep the two-step apply/finalize split in the
write-back exactly as documented — merging those steps makes the live page
flash back to its pre-edit text during every deploy.

Then give me a numbered checklist of everything I need to set up by hand:
which secrets go where (including the one that has to exist in two places),
and the exact webhook configuration — table, events, URL, and header — for
each one.
```

---

## Notes on writing your own

- **Name the scope boundary explicitly.** "Not repeating grid items unless
  you flag a good reason" is what keeps a retrofit from quietly turning into
  a multi-day project.
- **Say what must not change.** Design, copy, layout. Without it, a retrofit
  pass tends to "improve" things on the way through.
- **Ask for the diff before the rollout,** not after. Fixing a convention
  across 20 pages costs more than confirming it on 2.
- **Ask for the manual-steps list at the end.** Database rows, secrets, and
  webhooks can't be done for you, and they're the usual reason a build sits
  "finished" but not working.
