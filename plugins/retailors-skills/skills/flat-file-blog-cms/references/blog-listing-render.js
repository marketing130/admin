/* Blog listing page render script — drop into a <script> tag at the end of
   blog.html's <body>, after main site JS. Requires two elements to exist in
   the page: #blog-grid (the card container) and #pagination (button row).

   >>> CUSTOMIZE: PAGE_SIZE, and the card markup inside renderPage() to
   match the client's actual CSS classes/design. */

const PAGE_SIZE = 12;
let allPosts = [];
let currentPage = 1;

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(page) {
  currentPage = page;
  const grid = document.getElementById('blog-grid');
  const pagination = document.getElementById('pagination');
  const start = (page - 1) * PAGE_SIZE;
  const slice = allPosts.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(allPosts.length / PAGE_SIZE);

  grid.innerHTML = slice.map(p => {
    const date = p.date
      ? new Date(p.date).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    const imgHtml = p.cover_image ? `<img src="${escHtml(p.cover_image)}" alt="${escHtml(p.title)}" loading="lazy">` : '';
    // Links go to the extensionless /<slug> path, not /<slug>.html — see
    // "Why the stub files exist" in SKILL.md.
    return `
      <article class="blog-card">
        <div class="blog-card-img">${imgHtml}</div>
        <div class="blog-card-body">
          ${date ? `<time class="blog-card-date">${date}</time>` : ''}
          <h2 class="blog-card-title"><a href="/${encodeURIComponent(p.slug)}">${escHtml(p.title)}</a></h2>
          ${p.excerpt ? `<p class="blog-card-excerpt">${escHtml(p.excerpt)}</p>` : ''}
          <a href="/${encodeURIComponent(p.slug)}" class="blog-read-more">Read more &rarr;</a>
        </div>
      </article>`;
  }).join('');

  if (totalPages <= 1) {
    pagination.innerHTML = '';
    return;
  }

  let btns = '';
  btns += `<button onclick="changePage(${page - 1})" ${page === 1 ? 'disabled' : ''}>&larr; Prev</button>`;
  for (let i = 1; i <= totalPages; i++) {
    btns += `<button onclick="changePage(${i})" class="${i === page ? 'active' : ''}">${i}</button>`;
  }
  btns += `<button onclick="changePage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>Next &rarr;</button>`;
  pagination.innerHTML = btns;
}

function changePage(page) {
  if (page < 1 || page > Math.ceil(allPosts.length / PAGE_SIZE)) return;
  renderPage(page);
  document.getElementById('blog-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadPosts() {
  const grid = document.getElementById('blog-grid');
  try {
    const res = await fetch('posts.json');
    if (!res.ok) throw new Error('posts.json not found');
    allPosts = await res.json();

    if (!allPosts.length) {
      grid.innerHTML = '<div class="blog-state"><p>No posts yet. Check back soon.</p></div>';
      return;
    }

    renderPage(1);
  } catch (err) {
    grid.innerHTML = '<div class="blog-state"><p>Unable to load posts right now. Please try again shortly.</p></div>';
    console.error(err);
  }
}

loadPosts();
