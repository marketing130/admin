/* Blog detail page render script — drop into a <script> tag at the end of
   blog-post.html's <body>, after loading the `marked` library
   (https://cdn.jsdelivr.net/npm/marked/marked.min.js or similar).

   Requires these elements to exist in the page (adjust IDs to match the
   actual markup, or adjust this script to match existing IDs):
   #article-body, #post-hero-title, #breadcrumb-title, #post-hero-bg,
   #post-hero-date, #post-hero-divider, and a <meta name="description">
   tag already present in <head> (this script sets its content attribute,
   it doesn't create the tag).

   >>> CUSTOMIZE: the " — Site Name" suffix in document.title, and the
   fallback "back to blog" link URL. */

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

    /* Update page meta — CLIENT-SIDE ONLY. Does not update og:*, twitter:*,
       canonical, or JSON-LD — those stay generic for every post. See the
       "Important limitation" note in SKILL.md before assuming this is
       enough for social sharing / rich search results. */
    document.title = `${meta.title} — Site Name`; // >>> CUSTOMIZE
    document.querySelector('meta[name="description"]').setAttribute('content', meta.excerpt || '');

    /* Update hero */
    document.getElementById('post-hero-title').textContent = meta.title || '';
    document.getElementById('breadcrumb-title').textContent = meta.title || '';

    if (meta.cover_image) {
      document.getElementById('post-hero-bg').style.backgroundImage = `url('${meta.cover_image}')`;
    }

    if (meta.date) {
      const date = new Date(meta.date).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
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
