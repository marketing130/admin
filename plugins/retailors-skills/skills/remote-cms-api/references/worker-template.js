// ---- Remote CMS/SEO editing API (Cloudflare Worker) ----------------------
// Working template, kept in sync with a real deployed client build. Lets
// page SEO fields and marked-up content blocks (data-cms-id="...") be
// edited remotely via /api/cms/* instead of hand-editing HTML files. Every
// /api/cms/* request (except /ping and the two webhook routes, which carry
// their own secret) requires an `x-api-key` header matching env.CMS_API_KEY.
//
// Storage (this variant): a Supabase Edge Function holds the service_role
// key server-side and exposes a simpler x-api-key-gated REST interface over
// the content tables. This Worker never sees or needs the service_role key —
// the same CMS_API_KEY that gates incoming requests here is also sent on to
// the edge function, which resolves it to exactly one client row. See the
// SKILL.md "Choosing storage" section for the direct-Supabase and KV
// variants — only backendRequest()/backendUpsert() change; everything else
// in this file is reusable regardless of storage choice.
//
// Read/write model: GET /pages/:slug/content reads the CURRENT LIVE page
// HTML and extracts each editable field's real current value, then layers
// any saved edit on top (so a never-edited field still shows its real
// text, not null/blank). PUT /pages/:slug/content saves whichever fields
// were changed; the render pipeline (applyCmsOverrides) merges those edits
// back into the live HTML on the next page view.
//
// That merge is request-time only, so a saved edit would otherwise live
// solely in the database while the .html file in the repo drifts out of
// date — and hand-editing that file would silently stop working. The
// write-back pipeline (handleCmsContentWebhook -> sync-cms-to-html.js)
// closes the loop: it bakes each saved value into the file, commits it, and
// clears the row once the deploy is live, so the file stays the source of
// truth. See SKILL.md's "CMS -> HTML write-back" section.
//
// >>> CUSTOMIZE PER CLIENT: search for "CUSTOMIZE" comments below. There
// are six: backend URL, site origin, GitHub repo, the page list, the
// section-context rules, and the dispatch User-Agent. Everything else is
// client-agnostic.

// >>> CUSTOMIZE: the edge function / API base URL for this client's backend.
const CMS_BACKEND_URL = 'https://YOUR-PROJECT.supabase.co/functions/v1/cms-api';

// >>> CUSTOMIZE: the real production domain, no trailing slash.
// This API is typically also reachable on a test subdomain with identical
// behavior — fine for Content fields, but on-page SEO image URLs (og:image,
// twitter:image) get fetched directly by search engines and social-share
// crawlers, which only ever hit the real domain. Those always get anchored
// here, never to the request's own `url.origin`, so editing through a test
// subdomain (or a stray relative save) can never leak a non-production URL
// into live SEO metadata.
const SITE_ORIGIN = 'https://YOUR-CLIENT-DOMAIN.com';

// >>> CUSTOMIZE: owner/repo that the two webhook routes below fire a
// repository_dispatch at. Only needed if you're wiring up the image
// auto-localization and/or CMS -> HTML write-back pipelines.
const GITHUB_REPO = 'your-org/your-repo';

// >>> CUSTOMIZE: which page-level <head> fields are editable. This set
// (title/description/OG/canonical) covers the vast majority of sites as-is.
const PAGE_FIELDS = ['title', 'meta_description', 'og_title', 'og_description', 'og_image', 'canonical_path'];

// Table metadata for the page-level SEO fields, used to build the
// dashboard-ready field list returned by GET /pages/:slug/content.
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
  // ...one entry per real content page
];
const KNOWN_SLUGS = new Set(KNOWN_PAGES.map((p) => p.slug));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Gotcha #6: prevents a dashboard/browser/intermediary from showing a
      // stale read right after a fresh write.
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
// care where the rows live.

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

// Gotcha #4: don't assume the backend's write endpoints are true upserts. On
// the reference build POST is create-only (errors on an existing row) and
// PATCH is update-only (errors if the row doesn't exist yet), so upsert =
// try PATCH first, fall back to POST. `patchPayload` is sent as-is on PATCH;
// `createExtra` (e.g. the slug, which the PATCH path already encodes in the
// URL) is merged in only for the POST/create fallback.
//
// The bundled edge-function-template.ts DOES expose real upserts at
// PUT /pages/:slug and PUT /blocks/:slug/:key — prefer those if you control
// the backend. This PATCH-then-POST shape is kept because it works against
// both, including an edge function built by an app-builder platform that you
// can't change.
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
// A well-behaved retrofit is regular enough (leaf h1/h2/h4/p elements that
// never nest a same-named tag inside themselves) that a bounded regex is
// simpler and more predictable in a Workers runtime than accumulating
// HTMLRewriter events for extraction — and avoids a parsing dependency.

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

// >>> CUSTOMIZE: maps a content image's nearest wrapping element class to a
// human-readable section name, so the dashboard shows *where on the page* an
// image lives instead of a bare "Img 3". Use this client's real class names.
// Checked in order against the closest preceding class="..." attribute;
// first match wins. Purely cosmetic — it doesn't affect which backend row a
// field reads or writes, so a wrong or missing rule is a label bug, never a
// data bug.
const SECTION_CONTEXT_RULES = [
  [/related-card/, 'Related Service Photo'],
  [/service-card/, 'Service Card Photo'],
  [/about-intro/, 'About Intro Photo'],
  [/gallery-item/, 'Gallery Photo'],
];

function sectionContextFor(precedingHtml) {
  const classAttrs = [...precedingHtml.matchAll(/\sclass="([^"]*)"/g)];
  for (let i = classAttrs.length - 1; i >= 0; i--) {
    const rule = SECTION_CONTEXT_RULES.find(([pattern]) => pattern.test(classAttrs[i][1]));
    if (rule) return rule[1];
  }
  return 'Content Photo';
}

function extractBlockDefaults(html) {
  const blocks = {};
  const re = /<([a-zA-Z][\w-]*)[^>]*\sdata-cms-id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(html))) {
    const [, tag, key, inner] = match;
    blocks[key] = { tag: tag.toLowerCase(), html: inner.trim() };
    // Resume scanning just past this element's OPEN tag, not past the whole
    // match. THIS LINE IS LOAD-BEARING: a container that carries a
    // data-cms-id itself (e.g. a hero <section> that also wraps
    // hero-heading and hero-body) would otherwise swallow every descendant
    // key in one match and hide them from the field list completely. Its own
    // captured `inner` stays unusable, but that's fine — the
    // background-image pass below overwrites it.
    re.lastIndex = match.index + match[0].indexOf('>') + 1;
  }

  // <img> is a void element — it has no closing tag or inner content for the
  // regex above to capture, so its editable value (the `alt` attribute, the
  // primary image-SEO field) is extracted separately. `src` is captured at
  // the same time to back the derived `-src` field (see getPageContent).
  const imgRe = /<img\b([^>]*)>/g;
  while ((match = imgRe.exec(html))) {
    const attrs = match[1];
    const idMatch = attrs.match(/\sdata-cms-id="([^"]+)"/);
    if (!idMatch) continue;
    const altMatch = attrs.match(/\salt="([^"]*)"/);
    const srcMatch = attrs.match(/\ssrc="([^"]*)"/);
    const precedingHtml = html.slice(Math.max(0, match.index - 400), match.index);
    blocks[idMatch[1]] = {
      tag: 'img',
      html: altMatch ? altMatch[1] : '',
      src: srcMatch ? srcMatch[1] : '',
      context: sectionContextFor(precedingHtml),
    };
  }

  // Hero sections typically carry their photo as a CSS background-image
  // inside a `style` attribute, not as element content — and that outer
  // element usually wraps other data-cms-id descendants (hero-heading,
  // hero-body), which the closing-tag regex above can't safely bound (it'd
  // stop at the first nested `</div>`). Extract the background URL directly
  // from the tag's own attributes instead, overwriting whatever (unusable)
  // value the first pass may have produced for the same key.
  const bgRe = /<[a-zA-Z][\w-]*\b([^>]*)\sdata-cms-id="([^"]+)"([^>]*)>/g;
  while ((match = bgRe.exec(html))) {
    const attrs = match[1] + match[3];
    const key = match[2];
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
    if (!styleMatch) continue;
    const urlMatch = styleMatch[1].match(/url\(['"]?([^'")]*)['"]?\)/);
    if (!urlMatch) continue;
    blocks[key] = { tag: 'bg-image', html: urlMatch[1] };
  }

  return blocks;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// >>> CUSTOMIZE: add any acronyms specific to this client's block-key
// vocabulary so labels don't come out as "Faq" / "Cta".
const LABEL_ACRONYMS = { faq: 'FAQ', cta: 'CTA', seo: 'SEO' };
const LABEL_SUFFIXES = { heading: 'Heading', body: 'Body', title: 'Title', sub: 'Subtitle', alt: 'Alt Text', image: 'Image' };
const LABEL_OVERRIDES = { schema: 'Structured Data (JSON-LD)' };

function titleCaseWords(s) {
  return s.split('-').filter(Boolean)
    .map((w) => LABEL_ACRONYMS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Turns a block key's short name (without the page-slug prefix) into a
// human-readable table label — e.g. "hero-heading" -> "Hero Heading",
// "intro-p1" -> "Intro – Paragraph 1". Generic on purpose: a real retrofit
// runs to hundreds of block keys, so this avoids a hand-maintained lookup.
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

// `image`-type field values are stored/sent site-relative (e.g.
// "Media/foo.jpg") so a PUT never has to care which host it's being edited
// through — but that's not directly usable as an <img src> by a dashboard
// without hardcoding a domain (the opposite of that goal). `preview`
// resolves it against an origin instead, so it's always a ready-to-render
// URL regardless of `value`'s save-time shape. A no-op for already-absolute
// values (seo.og_image).
function toAbsoluteImageUrl(value, origin) {
  if (!value) return value;
  return new URL(value, origin).toString();
}

async function fetchPageHtml(env, url, slug) {
  const path = slug === 'index' ? '/' : `/${slug}.html`;
  const assetUrl = new URL(path, url.origin);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!res.ok) return null;
  return res.text();
}

// GET /api/cms/pages/:slug/content — a dashboard-ready table of every
// editable field on one page, with real current values (live HTML + any
// saved edit layered on top). Each row is self-describing: category/type for
// grouping, a label for display, a short plain-text preview for a table
// cell, and the full value to load into an edit dialog.
async function getPageContent(env, url, slug) {
  const html = await fetchPageHtml(env, url, slug);
  if (html === null) return jsonResponse({ error: 'Could not load page HTML' }, 502);

  const seoDefaults = extractSeoDefaults(html);
  const blockDefaults = extractBlockDefaults(html);

  // The CMS backend isn't required for this to work: if it's unreachable or
  // misbehaving, fall back to live-HTML defaults with no saved edits layered
  // in, and say so via `warning` rather than erroring.
  //
  // Pages and blocks are fetched INDEPENDENTLY (not via a combined
  // GET /pages/:slug response) because a page can have block overrides with
  // no page-level SEO row at all — that combined route 404s in that case,
  // which would silently discard real, successfully-saved block edits. This
  // is gotcha #3 in SKILL.md and it is very easy to reintroduce.
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
    let value = overrideValue != null ? overrideValue : (seoDefaults[field] || '');
    // og_image feeds the real og:image/twitter:image meta tags — always
    // anchored to the live production domain (SITE_ORIGIN), not url.origin,
    // so this is correct even when read through a test subdomain.
    // Normalizing `value` itself (not just `preview`) also guards a stray
    // relative override from rendering as a broken relative URL in those tags.
    if (meta.type === 'image' && value) value = toAbsoluteImageUrl(value, SITE_ORIGIN);
    fields.push({
      field_key: `seo.${field}`,
      category: 'SEO',
      type: meta.type,
      label: meta.label,
      value,
      preview: meta.type === 'image' ? value : toPreview(value),
    });
  }

  for (const [key, def] of Object.entries(blockDefaults)) {
    const value = overrideMap.has(key) ? overrideMap.get(key) : def.html;
    const shortName = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
    const isSchema = def.tag === 'script';
    const isImageAlt = def.tag === 'img';
    const isBgImage = def.tag === 'bg-image';
    // Only fields that actually feed backend/meta SEO (JSON-LD structured
    // data, and seo.og_image above) stay tagged "SEO". Content images — alt
    // text and the hero photo alike — are page content, not backend SEO
    // config, so they're tagged "Content" and labeled by the section they
    // live in rather than a bare number.
    const label = isImageAlt
      ? (value ? `${def.context} — ${toPreview(value, 40)}` : def.context)
      : labelForBlock(shortName);
    const type = isSchema ? 'code' : isImageAlt ? 'alt_text' : isBgImage ? 'image' : (HEADING_TAGS.has(def.tag) ? 'title' : 'body');
    fields.push({
      field_key: `block.${key}`,
      category: isSchema ? 'SEO' : 'Content',
      type,
      label,
      value,
      preview: type === 'image' ? toAbsoluteImageUrl(value, url.origin) : toPreview(value),
    });

    // Every content <img>'s underlying file is also swappable, as a sibling
    // `<key-without-"-alt">-src` field. Deliberately NOT a second
    // data-cms-id: BlockHandler derives it from the `-alt` key by suffix at
    // render time, so this feature needed zero markup changes. Saving a
    // remote URL here gets auto-localized into the repo by the
    // webhook -> GitHub Action pipeline further down.
    if (isImageAlt) {
      const srcKey = `${key.slice(0, -'-alt'.length)}-src`;
      const srcValue = overrideMap.has(srcKey) ? overrideMap.get(srcKey) : def.src;
      fields.push({
        field_key: `block.${srcKey}`,
        category: 'Content',
        type: 'image',
        label: `${def.context} — Image File`,
        value: srcValue,
        preview: toAbsoluteImageUrl(srcValue, url.origin),
      });
    }
  }

  return jsonResponse(warning ? { slug, fields, warning } : { slug, fields });
}

// GET /api/cms/pages/:slug/defaults — the same extraction getPageContent
// does, but WITHOUT any saved overrides layered on: purely what the
// currently-deployed HTML file says. getPageContent deliberately hides that
// distinction (a dashboard wants one merged value per field); the CMS ->
// HTML write-back needs the opposite, because "has the commit I just pushed
// actually deployed yet?" is only answerable from the raw file.
async function getPageDefaults(env, url, slug) {
  const html = await fetchPageHtml(env, url, slug);
  if (html === null) return jsonResponse({ error: 'Could not load page HTML' }, 502);

  const seo = extractSeoDefaults(html);
  // Anchored exactly like the merged read and both save paths, so a stored
  // og_image and its file default are comparable as plain strings.
  if (seo.og_image) seo.og_image = toAbsoluteImageUrl(seo.og_image, SITE_ORIGIN);

  // Keyed by block_key (== the data-cms-id, plus the derived `-src` keys),
  // so the caller can compare against stored rows one-to-one.
  const blocks = {};
  for (const [key, def] of Object.entries(extractBlockDefaults(html))) {
    blocks[key] = def.html;
    if (def.tag === 'img' && key.endsWith('-alt')) {
      blocks[`${key.slice(0, -'-alt'.length)}-src`] = def.src;
    }
  }

  return jsonResponse({ slug, seo, blocks });
}

// PUT /api/cms/pages/:slug/content — save one or more fields for a page.
// Body: { "fields": { "<field_key>": "<new value>", ... } } using the exact
// field_key values from the GET response above (e.g. "seo.title" or
// "block.about.hero-heading"). Send just the one field being saved, or
// several at once — both work.
async function savePageContent(request, env, slug) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null;
  if (!fields) {
    return jsonResponse({ error: '"fields" object is required, e.g. {"fields": {"seo.title": "..."}}' }, 400);
  }

  // Gotcha #5: track WHY each entry was accepted or skipped, and refuse to
  // report success if literally nothing was recognized. Silently falling
  // through to a 200 when every field failed a name check has shipped
  // undetected more than once.
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
        // og_image ends up verbatim in the live og:image/twitter:image meta
        // tags (MetaContentHandler sets `content` straight from what's
        // stored, with no resolution at render time) — normalize here too,
        // not just on read, so a save made through a test subdomain or with
        // a relative path can't reach the backend un-anchored.
        seoPayload[field] = field === 'og_image' && value ? toAbsoluteImageUrl(value, SITE_ORIGIN) : value;
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
    if (Object.keys(seoPayload).length) {
      const res = await backendUpsert(env, `/pages/${encodeURIComponent(slug)}`, '/pages', seoPayload, { slug });
      // Gotcha #5: check .ok on EVERY write. A fetch() whose status is never
      // inspected will happily let you report "saved" while the backend
      // rejected it.
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

  // Gotcha #7: a save must purge this page's render-time cache immediately,
  // or the live site won't reflect the edit until the cache expires.
  await purgeCmsCache(slug);
  return jsonResponse({ status: 'saved', slug, updated: Object.keys(fields) });
}

async function handleCmsApi(request, env, url) {
  // Public, unauthenticated health check — no backend call, safe to open
  // directly in a browser. Tells you at a glance whether the Worker is
  // actually running (gotcha #1) and whether auth is on.
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

  // /api/cms/pages/:slug/defaults — un-merged values from the deployed HTML
  if (parts.length === 3 && parts[2] === 'defaults') {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
    return getPageDefaults(env, url, slug);
  }

  // /api/cms/pages/:slug — page-level SEO fields only (raw backend row)
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
      // Same og_image anchoring as the recommended-flow save above — this
      // raw endpoint bypasses savePageContent entirely, so it needs its own.
      if (payload.og_image) payload.og_image = toAbsoluteImageUrl(payload.og_image, SITE_ORIGIN);
      const res = await backendUpsert(env, `/pages/${encodeURIComponent(slug)}`, '/pages', payload, { slug });
      const data = await res.json();
      await purgeCmsCache(slug);
      return jsonResponse(res.ok ? data.page : data, res.status);
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // /api/cms/pages/:slug/blocks[/:blockKey] — individual content blocks
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

// ---- Firing GitHub Actions from a database webhook ----------------------
// Both pipelines below need work done in the repo (downloading a file,
// rewriting HTML, committing) that a Worker can't do itself. The Worker's
// job is only to authenticate the webhook, decide whether the event is worth
// acting on, and hand off.

function dispatchRepositoryEvent(env, eventType, clientPayload) {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      // >>> CUSTOMIZE: any non-empty UA; GitHub rejects requests without one.
      'User-Agent': 'client-cms-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
}

// ---- Content image auto-localization ------------------------------------
// POST /api/cms/webhooks/image-src — called by a Supabase Database Webhook
// configured on cms_blocks (insert/update), NOT by the dashboard. Whenever a
// `<slug>.img-<n>-src` block's value gets set to a remote URL (however that
// write happened), this kicks off downloading it into the repo and
// rewriting the override to the local path — so the live site never depends
// on a third party's storage staying reachable. Blog cover images get the
// same treatment for free from a git push; CMS image edits land in the
// database instead, hence the webhook.
//
// Self-terminating by design: once the Action saves the local path back, the
// resulting write fires this webhook again, but the value is no longer a
// remote URL, so it's ignored. No [skip] marker needed.
async function handleCmsImageWebhook(request, env) {
  const secret = request.headers.get('x-webhook-secret');
  if (!env.CMS_WEBHOOK_SECRET || !secret || secret !== env.CMS_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const record = payload.record;
  if (payload.table !== 'cms_blocks' || !record || typeof record.block_key !== 'string' || !record.block_key.endsWith('-src')) {
    return jsonResponse({ status: 'ignored', reason: 'not an image-src block change' });
  }
  if (!/^https?:\/\//i.test(record.html || '')) {
    return jsonResponse({ status: 'ignored', reason: 'value is already a local path' });
  }
  if (!env.GITHUB_DISPATCH_TOKEN) {
    return jsonResponse({ error: 'GITHUB_DISPATCH_TOKEN not configured' }, 500);
  }

  const res = await dispatchRepositoryEvent(env, 'localize-cms-image', {
    page_slug: record.page_slug,
    block_key: record.block_key,
    image_url: record.html,
  });

  if (!res.ok) {
    return jsonResponse({ error: 'Failed to trigger GitHub Action', status: res.status, body: await res.text() }, 502);
  }

  return jsonResponse({ status: 'dispatched', page_slug: record.page_slug, block_key: record.block_key });
}

// ---- CMS -> HTML write-back ---------------------------------------------
// POST /api/cms/webhooks/content-sync — also a Supabase Database Webhook (on
// cms_blocks AND cms_pages, insert/update/delete), not a dashboard call. Any
// saved edit gets baked into the actual .html file in the repo, so the file —
// not the database — goes back to being the source of truth.
//
// Loop safety matters far more here than for image-src, because this fires
// on EVERY content save, and the sync's own cleanup is itself a write.
// Three guards, in order:
//   1. DELETE events are ignored — those are the sync's own row cleanup.
//   2. A fully-cleared page row is ignored — that's the SEO half of the same
//      cleanup, which arrives as an UPDATE (all nulls), not a DELETE.
//   3. A remote image URL is ignored — localize-cms-image is about to
//      rewrite it to a local path, and THAT write is what should sync.
async function handleCmsContentWebhook(request, env) {
  const secret = request.headers.get('x-webhook-secret');
  if (!env.CMS_WEBHOOK_SECRET || !secret || secret !== env.CMS_WEBHOOK_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try { payload = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  if (payload.type === 'DELETE') {
    return jsonResponse({ status: 'ignored', reason: 'row removal — this is the sync clearing what it already baked' });
  }

  const record = payload.record;
  if (!record) return jsonResponse({ status: 'ignored', reason: 'no record in payload' });

  let slug;
  if (payload.table === 'cms_blocks') {
    slug = record.page_slug;
    if (typeof record.block_key === 'string' && record.block_key.endsWith('-src') && /^https?:\/\//i.test(record.html || '')) {
      return jsonResponse({ status: 'ignored', reason: 'remote image URL — waiting for localization to write the local path' });
    }
  } else if (payload.table === 'cms_pages') {
    slug = record.slug;
    if (PAGE_FIELDS.every((field) => record[field] == null || record[field] === '')) {
      return jsonResponse({ status: 'ignored', reason: 'all SEO fields cleared — this is the sync clearing what it already baked' });
    }
  } else {
    return jsonResponse({ status: 'ignored', reason: `table "${payload.table}" is not synced` });
  }

  if (!slug || !KNOWN_SLUGS.has(slug)) {
    return jsonResponse({ status: 'ignored', reason: `unknown page slug "${slug}"` });
  }
  if (!env.GITHUB_DISPATCH_TOKEN) {
    return jsonResponse({ error: 'GITHUB_DISPATCH_TOKEN not configured' }, 500);
  }

  const res = await dispatchRepositoryEvent(env, 'sync-cms-content', { page_slug: slug });
  if (!res.ok) {
    return jsonResponse({ error: 'Failed to trigger GitHub Action', status: res.status, body: await res.text() }, 502);
  }

  return jsonResponse({ status: 'dispatched', page_slug: slug });
}

// ---- Request-time content injection ------------------------------------
// For normal page GETs, look up any CMS overrides for the page and stream
// the static HTML through HTMLRewriter. Pages with no overrides pass through
// untouched, and any backend error fails open (serves the static file as-is)
// so the live site never breaks because the CMS hiccupped.

function slugFromPath(pathname) {
  let slug = pathname.replace(/^\/+/, '').replace(/\.html$/, '');
  return slug === '' ? 'index' : slug;
}

async function getCmsData(env, ctx, slug) {
  const cache = caches.default;
  const cacheKey = cmsCacheKey(slug);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  // Fetched independently — same reason as in getPageContent().
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
    if (!key) return;
    const block = this.blocksMap.get(key);

    // <img> is a void element — its editable value is the `alt` attribute,
    // not inner content (there's nothing to set innerContent on).
    if (el.tagName === 'img') {
      if (block) el.setAttribute('alt', block.html);
      // The image file itself lives at a sibling `-src` override (see the
      // matching comment in getPageContent) rather than a second
      // data-cms-id, so it's looked up by suffix, not blocksMap.get(key).
      if (key.endsWith('-alt')) {
        const srcBlock = this.blocksMap.get(`${key.slice(0, -4)}-src`);
        if (srcBlock) el.setAttribute('src', srcBlock.html);
      }
      return;
    }

    if (!block) return;
    // Hero sections carry their photo as a CSS background-image inside
    // `style`, not as element content — swap just the url(...) part,
    // preserving the gradient overlay and everything else in the string.
    const style = el.getAttribute('style');
    if (style && /url\(/.test(style)) {
      el.setAttribute('style', style.replace(/url\(['"]?[^'")]*['"]?\)/, `url('${block.html}')`));
      return;
    }
    el.setInnerContent(block.html, { html: true });
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
    return assetResponse; // fail open, always
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

    // >>> CUSTOMIZE: add any other pre-existing routes this client's Worker
    // already served (form proxies, redirects, etc.) above the CMS routes.

    // The webhook routes are checked ahead of the generic /api/cms/* branch
    // because they're gated by their own x-webhook-secret, not the x-api-key
    // that branch requires.
    if (url.pathname === '/api/cms/webhooks/image-src') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      try {
        return await handleCmsImageWebhook(request, env);
      } catch (err) {
        return jsonResponse({ error: 'Internal error', message: String((err && err.message) || err) }, 500);
      }
    }

    if (url.pathname === '/api/cms/webhooks/content-sync') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      try {
        return await handleCmsContentWebhook(request, env);
      } catch (err) {
        return jsonResponse({ error: 'Internal error', message: String((err && err.message) || err) }, 500);
      }
    }

    // /api/cms/* — remote content & SEO editing
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

    // Serve static assets for everything else, applying any CMS overrides.
    // NOTE: this only ever runs if wrangler.jsonc sets
    // assets.run_worker_first = true — see references/wrangler-config.md.
    const assetResponse = await env.ASSETS.fetch(request);
    return applyCmsOverrides(request, env, ctx, url, assetResponse);
  },
};
