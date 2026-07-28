// ---- Remote CMS/SEO editing API (Cloudflare Worker) ----------------------
// Working template, adapted from a real client build. Lets page SEO fields
// and marked-up content blocks (data-cms-id="...") be edited remotely via
// /api/cms/* instead of hand-editing HTML files. Every /api/cms/* request
// (except /ping) requires an `x-api-key` header matching env.CMS_API_KEY.
//
// Storage (this variant): a Supabase Edge Function holds the service_role
// key server-side and exposes a simpler x-api-key-gated REST interface over
// content tables. This Worker never sees or needs the service_role key —
// the same CMS_API_KEY that gates incoming requests here is also sent on to
// the edge function. See the SKILL.md "Choosing storage" section if using
// direct Supabase REST or Cloudflare KV instead — only backendRequest()/
// backendUpsert() need to change; everything else in this file is reusable
// regardless of storage choice.
//
// Read/write model: GET /pages/:slug/content reads the CURRENT LIVE page
// HTML and extracts each editable field's real current value, then layers
// any saved edit on top (so a never-edited field still shows its real
// text, not null/blank). PUT /pages/:slug/content saves whichever fields
// were changed; the render pipeline (applyCmsOverrides) merges those edits
// back into the live HTML on the next page view.
//
// >>> CUSTOMIZE PER CLIENT: search for "CUSTOMIZE" comments below.

// >>> CUSTOMIZE: the edge function / API base URL for this client's backend.
const CMS_BACKEND_URL = 'https://YOUR-PROJECT.supabase.co/functions/v1/cms-api';

// >>> CUSTOMIZE: which page-level <head> fields are editable. This set
// (title/description/OG/canonical) covers the vast majority of sites as-is.
const PAGE_FIELDS = ['title', 'meta_description', 'og_title', 'og_description', 'og_image', 'canonical_path'];

const SEO_FIELD_META = {
  title: { label: 'Page Title', type: 'title' },
  meta_description: { label: 'Meta Description', type: 'body' },
  og_title: { label: 'Social Share Title', type: 'title' },
  og_description: { label: 'Social Share Description', type: 'body' },
  og_image: { label: 'Social Share Image', type: 'image' },
  canonical_path: { label: 'Canonical URL', type: 'link' },
};

// >>> CUSTOMIZE: this client's fixed set of editable pages. slug = the
// filename without .html ("index" for the homepage). Used for the page
// picker and to validate incoming slugs before they're used to fetch a
// static asset (never let a request-supplied slug reach env.ASSETS.fetch
// unchecked).
const KNOWN_PAGES = [
  { slug: 'index', label: 'Home' },
  // { slug: 'about', label: 'About' },
  // ...
];
const KNOWN_SLUGS = new Set(KNOWN_PAGES.map((p) => p.slug));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Gotcha #6: prevents a dashboard/browser from showing a stale read
      // right after a fresh write.
      'Cache-Control': 'no-store',
    },
  });
}

function requireApiKey(request, env) {
  // TEMPORARY (testing only): with no CMS_API_KEY secret configured, the
  // API is open to anyone who finds these URLs. Run `wrangler secret put
  // CMS_API_KEY` when testing is done to lock this back down — no other
  // code change needed, it takes effect immediately. Do not ship a real
  // client's production site with this left open.
  if (!env.CMS_API_KEY) return null;
  const key = request.headers.get('x-api-key');
  if (!key || key !== env.CMS_API_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  return null;
}

// ---- Talking to the storage backend --------------------------------------
// This variant talks to a Supabase Edge Function. If using direct Supabase
// REST (PostgREST) or Cloudflare KV instead, replace backendRequest() and
// backendUpsert() below with equivalents — the rest of this file (field
// extraction, the dashboard-ready field list, the render pipeline) doesn't
// need to change.

async function backendRequest(env, path, options = {}) {
  return fetch(`${CMS_BACKEND_URL}${path}`, {
    method: options.method || 'GET',
    body: options.body,
    headers: {
      'x-api-key': env.CMS_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// Gotcha #4: don't assume a write endpoint is a true upsert. Probe the
// actual backend with curl before writing this — the edge function in the
// reference build had POST as create-only (errors on duplicate) and PATCH
// as update-only (errors if missing), so upsert = try PATCH first, fall
// back to POST on failure. `patchPayload` is sent as-is on PATCH;
// `createExtra` (e.g. the slug/key, already encoded in the PATCH URL) is
// merged in only for the POST/create fallback. If the real backend IS a
// true upsert (e.g. raw PostgREST with `Prefer: resolution=merge-
// duplicates` and an `on_conflict` param), this can collapse to one call.
async function backendUpsert(env, patchPath, createPath, patchPayload, createExtra) {
  const patchRes = await backendRequest(env, patchPath, {
    method: 'PATCH',
    body: JSON.stringify(patchPayload),
  });
  if (patchRes.ok) return patchRes;
  return backendRequest(env, createPath, {
    method: 'POST',
    body: JSON.stringify({ ...createExtra, ...patchPayload }),
  });
}

function cmsCacheKey(slug) {
  return new Request(`https://cms-cache.internal/${encodeURIComponent(slug)}`);
}

async function purgeCmsCache(slug) {
  await caches.default.delete(cmsCacheKey(slug));
}

// ---- Extracting current live values out of the static HTML -------------
// A regular retrofit (leaf h1/h2/h4/p/script elements, never nesting a
// same-named tag inside themselves) makes a bounded regex simpler and more
// predictable here than accumulating HTMLRewriter events for extraction.
// This only holds if the data-cms-id convention below is followed — don't
// tag an element that could contain another element of the same tag name.

function extractSeoDefaults(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };
  return {
    title: pick(/<title>([\s\S]*?)<\/title>/),
    meta_description: pick(/<meta\s+name="description"\s+content="([^"]*)"/),
    og_title: pick(/<meta\s+property="og:title"\s+content="([^"]*)"/),
    og_description: pick(/<meta\s+property="og:description"\s+content="([^"]*)"/),
    og_image: pick(/<meta\s+property="og:image"\s+content="([^"]*)"/),
    canonical_path: pick(/<link\s+rel="canonical"\s+href="([^"]*)"/),
  };
}

function extractBlockDefaults(html) {
  const blocks = {};
  const re = /<([a-zA-Z][\w-]*)[^>]*\sdata-cms-id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(html))) {
    const [, tag, key, inner] = match;
    blocks[key] = { tag: tag.toLowerCase(), html: inner.trim() };
  }
  return blocks;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// >>> CUSTOMIZE: add any acronyms specific to this client's block-key
// vocabulary (industry terms, brand names) so labels read naturally.
const LABEL_ACRONYMS = { faq: 'FAQ', cta: 'CTA', seo: 'SEO' };
const LABEL_SUFFIXES = { heading: 'Heading', body: 'Body', title: 'Title', sub: 'Subtitle' };
const LABEL_OVERRIDES = { schema: 'Structured Data (JSON-LD)' };

function titleCaseWords(s) {
  return s.split('-').filter(Boolean)
    .map((w) => LABEL_ACRONYMS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Turns a block key's short name (without the page-slug prefix) into a
// human-readable table label — e.g. "hero-heading" -> "Hero Heading",
// "intro-p1" -> "Intro – Paragraph 1". Generic on purpose: a mid-size site
// easily has 200+ block keys, so this avoids a hand-maintained lookup.
function labelForBlock(shortName) {
  if (LABEL_OVERRIDES[shortName]) return LABEL_OVERRIDES[shortName];
  const pMatch = shortName.match(/^(.*)-p(\d+)$/);
  if (pMatch) return `${titleCaseWords(pMatch[1])} – Paragraph ${pMatch[2]}`;
  const dashIdx = shortName.lastIndexOf('-');
  if (dashIdx > -1) {
    const base = shortName.slice(0, dashIdx);
    const suffix = shortName.slice(dashIdx + 1);
    if (LABEL_SUFFIXES[suffix]) return `${titleCaseWords(base)} ${LABEL_SUFFIXES[suffix]}`;
  }
  return titleCaseWords(shortName);
}

function toPreview(value, maxLen = 100) {
  const text = String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

async function fetchPageHtml(env, url, slug) {
  const path = slug === 'index' ? '/' : `/${slug}.html`;
  const assetUrl = new URL(path, url.origin); // gotcha #8: never hardcode a domain
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!res.ok) return null;
  return res.text();
}

// GET /api/cms/pages/:slug/content — a dashboard-ready table of every
// editable field on one page, with real current values (live HTML + any
// saved edit layered on top). Each row is self-describing: category/type
// for grouping, a label for display, a short plain-text preview for a
// table cell, and the full value to load into an edit dialog.
async function getPageContent(env, url, slug) {
  const html = await fetchPageHtml(env, url, slug);
  if (html === null) return jsonResponse({ error: 'Could not load page HTML' }, 502);

  const seoDefaults = extractSeoDefaults(html);
  const blockDefaults = extractBlockDefaults(html);

  // The CMS backend isn't required for this to work: if it's unreachable
  // or misbehaving, fall back to live-HTML defaults with no saved edits
  // layered in, and say so via `warning` rather than erroring.
  //
  // Gotcha #3: pages and blocks are fetched INDEPENDENTLY, not via a single
  // combined GET /pages/:slug call, even if the backend conveniently offers
  // one. A page can have block overrides with no page-level SEO row at all
  // (very common — most edits are to a heading, not the page title), and a
  // combined endpoint that 404s on "no SEO row" will silently drop real,
  // successfully-saved block overrides too if you let that 404 short-
  // circuit before reading blocks.
  let pageOverride = null;
  let blockOverrides = [];
  let warning;
  try {
    const [pageRes, blocksRes] = await Promise.all([
      backendRequest(env, `/pages/${encodeURIComponent(slug)}`),
      backendRequest(env, `/blocks?page_slug=${encodeURIComponent(slug)}`),
    ]);
    if (pageRes.ok) {
      pageOverride = (await pageRes.json()).page || null;
    } else if (pageRes.status !== 404) {
      warning = `CMS backend returned an unexpected error (${pageRes.status}) fetching page fields — showing live defaults for those.`;
    }
    if (blocksRes.ok) {
      blockOverrides = (await blocksRes.json()).blocks || [];
    } else if (blocksRes.status !== 404) {
      warning = `${warning ? warning + ' ' : ''}CMS backend returned an unexpected error (${blocksRes.status}) fetching blocks — showing live defaults for those.`;
    }
  } catch {
    warning = 'Could not reach the CMS backend — showing live page defaults only. Saved edits will not appear, and Save may not persist, until this is resolved.';
  }
  const overrideMap = new Map(blockOverrides.map((b) => [b.block_key, b.html]));

  const fields = [];

  for (const field of PAGE_FIELDS) {
    const meta = SEO_FIELD_META[field];
    const overrideValue = pageOverride ? pageOverride[field] : null;
    const value = overrideValue != null ? overrideValue : (seoDefaults[field] || '');
    fields.push({
      field_key: `seo.${field}`,
      category: 'SEO',
      type: meta.type,
      label: meta.label,
      value,
      preview: toPreview(value),
    });
  }

  for (const [key, def] of Object.entries(blockDefaults)) {
    const value = overrideMap.has(key) ? overrideMap.get(key) : def.html;
    const shortName = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
    // A <script type="application/ld+json"> block tagged with data-cms-id
    // uses the exact same extraction mechanism as any other block — just
    // categorized/typed differently so a dashboard can treat it as raw
    // JSON rather than an HTML fragment.
    const isSchema = def.tag === 'script';
    fields.push({
      field_key: `block.${key}`,
      category: isSchema ? 'SEO' : 'Content',
      type: isSchema ? 'code' : (HEADING_TAGS.has(def.tag) ? 'title' : 'body'),
      label: labelForBlock(shortName),
      value,
      preview: toPreview(value),
    });
  }

  return jsonResponse(warning ? { slug, fields, warning } : { slug, fields });
}

// PUT /api/cms/pages/:slug/content — save one or more fields for a page.
// Body: { "fields": { "<field_key>": "<new value>", ... } } using the
// exact field_key values from the GET response above (e.g. "seo.title" or
// "block.about.hero-heading"). Send just the one field being saved, or
// several at once — both work.
async function savePageContent(request, env, slug) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  if (!fields) {
    return jsonResponse({ error: '"fields" object is required, e.g. {"fields": {"seo.title": "..."}}' }, 400);
  }

  // Gotcha #5: track exactly why each field was accepted or skipped, and
  // refuse to report success if literally nothing was recognized. Silently
  // doing nothing while still returning {"status":"saved"} is the single
  // easiest way for this whole feature to look broken to a user while
  // giving you zero signal about why.
  const seoPayload = {};
  const blockWrites = [];
  const skipped = [];
  for (const [fieldKey, value] of Object.entries(fields)) {
    if (typeof value !== 'string') {
      skipped.push({ fieldKey, reason: `value must be a string, got ${typeof value}` });
      continue;
    }
    if (fieldKey.startsWith('seo.')) {
      const field = fieldKey.slice(4);
      if (PAGE_FIELDS.includes(field)) {
        seoPayload[field] = value;
      } else {
        skipped.push({ fieldKey, reason: `"${field}" is not a recognized SEO field (expected one of: ${PAGE_FIELDS.join(', ')})` });
      }
    } else if (fieldKey.startsWith('block.')) {
      blockWrites.push([fieldKey.slice(6), value]);
    } else {
      skipped.push({ fieldKey, reason: 'field_key must start with "seo." or "block."' });
    }
  }

  if (!Object.keys(seoPayload).length && !blockWrites.length) {
    return jsonResponse({
      error: 'Nothing recognized to save — no fields were actually written.',
      hint: 'field_key values must exactly match what GET .../content returned (e.g. "seo.title" or "block.about.hero-heading").',
      skipped,
    }, 400);
  }

  try {
    // Gotcha #5 continued: always check res.ok on every write — a fetch()
    // that "succeeds" at the JS level can still carry a rejection status.
    if (Object.keys(seoPayload).length) {
      const res = await backendUpsert(env, `/pages/${encodeURIComponent(slug)}`, '/pages', seoPayload, { slug });
      if (!res.ok) {
        return jsonResponse({ error: 'Save failed while writing SEO fields.', backendStatus: res.status, backendError: await res.text() }, 502);
      }
    }

    for (const [blockKey, html] of blockWrites) {
      const res = await backendUpsert(
        env,
        `/blocks/${encodeURIComponent(slug)}/${encodeURIComponent(blockKey)}`,
        '/blocks',
        { html },
        { page_slug: slug, block_key: blockKey },
      );
      if (!res.ok) {
        return jsonResponse({ error: `Save failed while writing block "${blockKey}".`, backendStatus: res.status, backendError: await res.text() }, 502);
      }
    }
  } catch (err) {
    return jsonResponse({
      error: 'Save failed: could not reach the CMS backend.',
      message: String((err && err.message) || err),
    }, 503);
  }

  // Gotcha #7: purge the render-time cache so this save is visible on the
  // live site immediately, not after the cache TTL expires.
  await purgeCmsCache(slug);
  return jsonResponse({ status: 'saved', slug, updated: Object.keys(fields) });
}

async function handleCmsApi(request, env, url) {
  // Public, unauthenticated health check — no backend call, safe to open
  // directly in a browser. Extremely useful during setup: hit this first
  // to confirm the Worker is actually running before debugging anything
  // else (see gotcha #1 — if this 404s with an empty body while normal
  // pages load fine, check wrangler.jsonc before anything else).
  if (url.pathname === '/api/cms/ping') {
    return jsonResponse({
      status: 'ok',
      message: 'CMS API worker is deployed and responding.',
      authMode: env.CMS_API_KEY ? 'protected (x-api-key required)' : 'OPEN — no CMS_API_KEY set, anyone can read/write',
      backendConfigured: Boolean(env.CMS_API_KEY),
    });
  }

  const authFail = requireApiKey(request, env);
  if (authFail) return authFail;

  const parts = url.pathname.replace(/^\/api\/cms\//, '').split('/').filter(Boolean);

  if (parts[0] !== 'pages') {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  // GET /api/cms/pages — the fixed page picker list
  if (parts.length === 1) {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
    return jsonResponse(KNOWN_PAGES);
  }

  const slug = parts[1];
  if (!KNOWN_SLUGS.has(slug)) {
    return jsonResponse({ error: 'Unknown page slug' }, 404);
  }

  // /api/cms/pages/:slug/content — recommended: everything for one page
  if (parts.length === 3 && parts[2] === 'content') {
    if (request.method === 'GET') return getPageContent(env, url, slug);
    if (request.method === 'PUT') return savePageContent(request, env, slug);
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // /api/cms/pages/:slug — page-level SEO fields only (raw backend row) —
  // lower-level, mainly useful for debugging.
  if (parts.length === 2) {
    if (request.method === 'GET') {
      const res = await backendRequest(env, `/pages/${encodeURIComponent(slug)}`);
      if (res.status === 404) return jsonResponse(null, 200);
      const data = await res.json();
      return jsonResponse(res.ok ? (data.page || null) : data, res.status);
    }
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
      const payload = {};
      for (const field of PAGE_FIELDS) if (field in body) payload[field] = body[field];
      const res = await backendUpsert(env, `/pages/${encodeURIComponent(slug)}`, '/pages', payload, { slug });
      const data = await res.json();
      await purgeCmsCache(slug);
      return jsonResponse(res.ok ? data.page : data, res.status);
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // /api/cms/pages/:slug/blocks[/:blockKey] — individual content blocks,
  // lower-level. DELETE reverts a block to the static default.
  if (parts[2] === 'blocks') {
    if (parts.length === 3) {
      if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
      const res = await backendRequest(env, `/blocks?page_slug=${encodeURIComponent(slug)}`);
      const data = await res.json();
      return jsonResponse(res.ok ? (data.blocks || []) : data, res.status);
    }

    const blockKey = parts[3];

    if (parts.length === 4) {
      if (request.method === 'GET') {
        const res = await backendRequest(env, `/blocks?page_slug=${encodeURIComponent(slug)}`);
        const data = await res.json();
        const block = res.ok ? (data.blocks || []).find((b) => b.block_key === blockKey) || null : null;
        return jsonResponse(res.ok ? block : data, res.status);
      }
      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
        if (typeof body.html !== 'string') return jsonResponse({ error: '"html" field (string) is required' }, 400);
        const res = await backendUpsert(
          env,
          `/blocks/${encodeURIComponent(slug)}/${encodeURIComponent(blockKey)}`,
          '/blocks',
          { html: body.html },
          { page_slug: slug, block_key: blockKey },
        );
        const data = await res.json();
        await purgeCmsCache(slug);
        return jsonResponse(res.ok ? data.block : data, res.status);
      }
      if (request.method === 'DELETE') {
        const res = await backendRequest(env, `/blocks/${encodeURIComponent(slug)}/${encodeURIComponent(blockKey)}`, { method: 'DELETE' });
        await purgeCmsCache(slug);
        return new Response(null, { status: res.ok ? 204 : res.status });
      }
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

// ---- Request-time content injection ------------------------------------
// For normal page GETs, look up any CMS overrides for the page and stream
// the static HTML through HTMLRewriter. Pages with no overrides pass
// through untouched, and any backend error fails open (serves the static
// file as-is) — gotcha applies here too: the site must never break because
// this feature had a bad moment.

function slugFromPath(pathname) {
  let slug = pathname.replace(/^\/+/, '').replace(/\.html$/, '');
  return slug === '' ? 'index' : slug;
}

async function getCmsData(env, ctx, slug) {
  const cache = caches.default;
  const cacheKey = cmsCacheKey(slug);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  // Same independent-fetch reasoning as getPageContent() above.
  let page = null;
  let blocks = [];
  const [pageRes, blocksRes] = await Promise.all([
    backendRequest(env, `/pages/${encodeURIComponent(slug)}`),
    backendRequest(env, `/blocks?page_slug=${encodeURIComponent(slug)}`),
  ]);
  if (pageRes.ok) page = (await pageRes.json()).page || null;
  if (blocksRes.ok) blocks = (await blocksRes.json()).blocks || [];
  const data = { page, blocks };

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' },
  })));

  return data;
}

class TitleHandler {
  constructor(page) { this.page = page; }
  element(el) {
    if (this.page?.title) el.setInnerContent(this.page.title);
  }
}

class MetaContentHandler {
  constructor(page, field) { this.page = page; this.field = field; }
  element(el) {
    const value = this.page?.[this.field];
    if (value) el.setAttribute('content', value);
  }
}

class CanonicalHandler {
  constructor(page) { this.page = page; }
  element(el) {
    if (this.page?.canonical_path) el.setAttribute('href', this.page.canonical_path);
  }
}

class BlockHandler {
  constructor(blocksMap) { this.blocksMap = blocksMap; }
  element(el) {
    const key = el.getAttribute('data-cms-id');
    const block = key && this.blocksMap.get(key);
    if (block) el.setInnerContent(block.html, { html: true });
  }
}

async function applyCmsOverrides(request, env, ctx, url, assetResponse) {
  const contentType = assetResponse.headers.get('content-type') || '';
  if (request.method !== 'GET' || !contentType.includes('text/html')) {
    return assetResponse;
  }

  let data;
  try {
    data = await getCmsData(env, ctx, slugFromPath(url.pathname));
  } catch {
    return assetResponse;
  }

  const hasBlocks = data.blocks && data.blocks.length > 0;
  if (!data.page && !hasBlocks) {
    return assetResponse;
  }

  const page = data.page;
  const blocksMap = new Map((data.blocks || []).map((b) => [b.block_key, b]));

  return new HTMLRewriter()
    .on('title', new TitleHandler(page))
    .on('meta[name="description"]', new MetaContentHandler(page, 'meta_description'))
    .on('meta[property="og:title"]', new MetaContentHandler(page, 'og_title'))
    .on('meta[name="twitter:title"]', new MetaContentHandler(page, 'og_title'))
    .on('meta[property="og:description"]', new MetaContentHandler(page, 'og_description'))
    .on('meta[name="twitter:description"]', new MetaContentHandler(page, 'og_description'))
    .on('meta[property="og:image"]', new MetaContentHandler(page, 'og_image'))
    .on('meta[name="twitter:image"]', new MetaContentHandler(page, 'og_image'))
    .on('meta[property="og:url"]', new MetaContentHandler(page, 'canonical_path'))
    .on('link[rel="canonical"]', new CanonicalHandler(page))
    .on('[data-cms-id]', new BlockHandler(blocksMap))
    .transform(assetResponse);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // >>> CUSTOMIZE: add any other pre-existing routes this client's
    // Worker needs to keep handling (remove this block if there are none).
    // if (url.pathname === '/some-other-existing-route') { ... }

    // Handle /api/cms/* — remote content & SEO editing
    if (url.pathname.startsWith('/api/cms/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'x-api-key,Content-Type',
          },
        });
      }
      try {
        return await handleCmsApi(request, env, url);
      } catch (err) {
        return jsonResponse({ error: 'Internal error', message: String((err && err.message) || err) }, 500);
      }
    }

    // Serve static assets for everything else, applying any CMS overrides
    const assetResponse = await env.ASSETS.fetch(request);
    return applyCmsOverrides(request, env, ctx, url, assetResponse);
  },
};
