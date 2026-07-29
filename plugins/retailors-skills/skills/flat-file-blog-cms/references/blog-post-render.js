/* Blog detail page render script — drop into a <script> tag at the end of
   blog-post.html's <body>, after loading the `marked` library
   (https://cdn.jsdelivr.net/npm/marked/marked.min.js or similar).

   Requires these elements to exist in the page (adjust IDs to match the
   actual markup, or adjust this script to match existing IDs):
   #article-body, #post-hero-title, #breadcrumb-title, #post-hero-bg,
   #post-hero-date, #post-hero-divider, and these already present in <head>
   (this script only sets attributes on them, it doesn't create any of
   them): <meta name="description">, <link rel="canonical">,
   <meta property="og:title">, <meta property="og:description">,
   <meta property="og:url">, <meta property="og:image">,
   <meta name="twitter:title">, <meta name="twitter:description">,
   <meta name="twitter:image">.

   >>> CUSTOMIZE: SITE_ORIGIN, the " — Site Name" suffix in document.title,
   and the fallback "back to blog" link URL. */

const SITE_ORIGIN = 'https://example.com'; // >>> CUSTOMIZE — no trailing slash

// cover_image may be an absolute URL (still-remote image) or a site-relative
// path like "Media/foo.jpg" (the recommended, localized form — see
// "Featured images" in SKILL.md). og:image/twitter:image require an
// absolute URL for social-share crawlers to resolve it, so always resolve
// through this before writing it into a meta tag.
function toAbsoluteUrl(value) {
  if (!value) return value;
  return /^https?:\/\//i.test(value) ? value : `${SITE_ORIGIN}/${value.replace(/^\/+/, '')}`;
}

/* ── PARSE FRONTMATTER ──
   Not a real YAML parser — splits each frontmatter line on the FIRST
   colon only, then strips one leading/trailing double-quote from the
   value if present. Handles the flat title/slug/date/excerpt/cover_image
   shape fine (including values that contain their own colon, like a URL,
   since only the first colon is treated as the delimiter). Don't assume
   it handles multi-line values or nested structures without testing. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  match[1].split('\n').forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key) meta[key.trim()] = rest.join(':').trim().replace(/^"|"$/g, '');
  });
  return { meta, body: match[2].trim() };
}

/* ── LOAD POST ──
   Slug resolution order: ?slug= query param, then /blog/<slug> path,
   then a generic /<anything-at-root> catch-all (this last one is what
   makes the extensionless /<slug> URL from the listing page work when
   it's actually reached via the stub-file document.write proxy — see
   "Why the stub files exist" in SKILL.md). */
async function loadPost() {
  const articleBody = document.getElementById('article-body');
  let slug = new URLSearchParams(window.location.search).get('slug');
  if (!slug) {
    const blogMatch = window.location.pathname.match(/^\/blog\/(.+)$/);
    if (blogMatch) slug = decodeURIComponent(blogMatch[1]);
  }
  if (!slug) {
    const rootMatch = window.location.pathname.match(/^\/([^\/]+)$/);
    if (rootMatch) slug = decodeURIComponent(rootMatch[1]);
  }

  if (!slug) {
    articleBody.innerHTML = '<div class="post-state"><p>Post not found. <a href="blog.html">Back to Blog</a></p></div>';
    return;
  }

  try {
    const res = await fetch(`posts/${encodeURIComponent(slug)}.md`);
    if (!res.ok) throw new Error('Not found');

    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);

    /* Update page meta — CLIENT-SIDE ONLY, so still invisible to anything
       that doesn't execute JS (most social-media link unfurlers and some
       crawlers see only whatever's baked into the static HTML). But for
       anything that DOES run JS, every one of these becomes post-specific
       rather than staying at generic/blog-listing-level values — see
       "Important limitation" in SKILL.md for the full caveat and a
       server-side option if that JS-invisibility matters for this client. */
    const postUrl = `${SITE_ORIGIN}/${encodeURIComponent(slug)}`;
    document.title = `${meta.title} — Site Name`; // >>> CUSTOMIZE
    document.querySelector('meta[name="description"]').setAttribute('content', meta.excerpt || '');
    document.querySelector('link[rel="canonical"]').setAttribute('href', postUrl);
    document.querySelector('meta[property="og:title"]').setAttribute('content', meta.title || '');
    document.querySelector('meta[property="og:description"]').setAttribute('content', meta.excerpt || '');
    document.querySelector('meta[property="og:url"]').setAttribute('content', postUrl);
    document.querySelector('meta[name="twitter:title"]').setAttribute('content', meta.title || '');
    document.querySelector('meta[name="twitter:description"]').setAttribute('content', meta.excerpt || '');
    if (meta.cover_image) {
      const absoluteCoverImage = toAbsoluteUrl(meta.cover_image);
      document.querySelector('meta[property="og:image"]').setAttribute('content', absoluteCoverImage);
      document.querySelector('meta[name="twitter:image"]').setAttribute('content', absoluteCoverImage);
    }

    /* Update hero */
    document.getElementById('post-hero-title').textContent = meta.title || '';
    document.getElementById('breadcrumb-title').textContent = meta.title || '';

    if (meta.cover_image) {
      document.getElementById('post-hero-bg').style.backgroundImage = `url('${meta.cover_image}')`;
    }

    if (meta.date) {
      // timeZone: 'UTC' matters here — meta.date is a bare "YYYY-MM-DD"
      // (no time component), so without pinning the zone, users west of UTC
      // see the date rendered as one day earlier than what's in the file.
      const date = new Date(meta.date).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      document.getElementById('post-hero-date').textContent = date;
      document.getElementById('post-hero-divider').style.display = 'block';
    }

    /* Render markdown body */
    const contentHtml = marked.parse(body);
    articleBody.innerHTML = `
      <a href="blog.html" class="article-back">&larr; Back to Blog</a>
      ${meta.excerpt ? `<p class="article-excerpt">${meta.excerpt}</p>` : ''}
      <div class="article-content">${contentHtml}</div>`;

  } catch (err) {
    articleBody.innerHTML = '<div class="post-state"><p>Article not found. <a href="blog.html">Back to Blog</a></p></div>';
  }
}

loadPost();
