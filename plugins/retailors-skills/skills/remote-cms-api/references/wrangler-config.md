# wrangler.jsonc config

The config fields that matter for this pattern, and why. This is gotcha #1
from SKILL.md — get this right before writing any Worker code, and verify
it with a live curl test before assuming it's correct.

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "client-site-name",
  "compatibility_date": "2026-01-01",
  "main": "_worker.js",
  "observability": {
    "enabled": true
  },
  "assets": {
    "directory": ".",
    "binding": "ASSETS",
    "run_worker_first": true
  },
  "compatibility_flags": [
    "nodejs_compat"
  ]
}
```

## Why each field matters

- **`"main": "_worker.js"`** — explicitly declares the Worker's entry
  script. Some Cloudflare project setups will auto-detect a root-level
  `_worker.js` without this (the "Pages Advanced Mode" convention), but
  don't rely on that happening — declare it explicitly.

- **`"assets": { "run_worker_first": true }`** — this is the one that
  actually matters most, and the one most likely to be missing from an
  existing site's config. **Without it, Cloudflare's default behavior is
  to check whether an incoming request matches a static file FIRST, and
  serve it directly if so — without ever invoking the Worker script at
  all.** For a typical site, most paths match a static file (every real
  page does), so the Worker effectively never runs for normal page views.
  It only gets invoked as a fallback for paths that don't match any file.

  The failure mode this produces is genuinely confusing: static pages
  render completely normally (they're just the raw, unprocessed files),
  while any custom API route under something like `/api/cms/*` returns a
  bare Cloudflare 404 — empty body, no `content-type` header, nothing but
  `server: cloudflare` and a `cf-ray` header. That specific signature (empty
  404, no custom headers, on a path that isn't a real file) means the
  Worker script never ran for that request. It's easy to burn a lot of time
  suspecting a WAF rule, a DNS misconfiguration, or a stale deployment
  instead, because all of those can produce superficially similar symptoms.
  Check this config first.

- **`"binding": "ASSETS"`** — needed so `env.ASSETS.fetch(request)` works
  inside the Worker to serve static files (the render pipeline explicitly
  fetches the static asset itself, then optionally rewrites it — this only
  works if the binding exists).

## How to verify this is actually right, not just present in the file

Deploy, then hit the health-check endpoint (`/api/cms/ping` in the
template) on the real deployed URL — not `localhost`, not a preview, the
actual domain — with `curl`:

```bash
curl -s https://the-real-domain.com/api/cms/ping
```

If this returns real JSON, the Worker is running. If it returns an empty
`404`, re-check this config before looking anywhere else. If you have
access to the Worker's own `*.workers.dev` URL, testing there too is a
useful way to rule out DNS/domain-binding issues entirely and isolate the
problem to purely this config vs. something zone-level.
