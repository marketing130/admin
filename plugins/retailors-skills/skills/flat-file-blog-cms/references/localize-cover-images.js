#!/usr/bin/env node
/* Downloads every remotely-hosted `cover_image` (a post's featured image)
   into the repo's Media/ folder and rewrites the reference — in both
   posts.json and the matching posts/<slug>.md frontmatter — to the local
   path. Run this after any post is added/edited with a remote cover_image
   (e.g. published through an external dashboard/CMS that only gives you a
   signed storage URL) so the site doesn't depend on that external storage
   staying reachable forever.

   Real incident that motivates this: a signed Supabase Storage URL for one
   post's cover_image started 404ing (object deleted upstream) months after
   publish, silently breaking that post's hero image and social-share image
   with no local fallback. Local files don't expire or get deleted out from
   under the site.

   Requires Node 18+ (built-in fetch). No dependencies.

   Usage:
     node localize-cover-images.js
     node localize-cover-images.js --dry-run   (report only, no downloads/writes)

   >>> CUSTOMIZE: MEDIA_DIR / POSTS_JSON / POSTS_DIR if this project's file
   layout differs from the SKILL.md convention. */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const MEDIA_DIR = path.join(ROOT, 'Media');
const POSTS_JSON = path.join(ROOT, 'posts.json');
const POSTS_DIR = path.join(ROOT, 'posts');
const DRY_RUN = process.argv.includes('--dry-run');

function extFromContentTypeOrUrl(contentType, url) {
  const ctMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };
  if (contentType && ctMap[contentType.split(';')[0].trim()]) return ctMap[contentType.split(';')[0].trim()];
  const m = url.match(/\.(jpe?g|png|webp|gif|svg)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

// Rewrites a `key: "value"` (or unquoted) frontmatter line for the given
// key only, leaving every other line untouched. Mirrors the parser this
// skill's rendering scripts use — first-colon split, optional surrounding
// quotes — so this only touches what those scripts would actually read.
function rewriteFrontmatterField(mdText, key, newValue) {
  const lines = mdText.split('\n');
  let inFrontmatter = false;
  let frontmatterEnds = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue; }
      frontmatterEnds = i;
      break;
    }
    if (inFrontmatter) {
      const colonIdx = lines[i].indexOf(':');
      if (colonIdx > -1 && lines[i].slice(0, colonIdx).trim() === key) {
        lines[i] = `${key}: "${newValue}"`;
      }
    }
  }
  if (frontmatterEnds === -1) return mdText; // no frontmatter block found — leave untouched
  return lines.join('\n');
}

async function main() {
  if (!fs.existsSync(POSTS_JSON)) {
    console.error(`Not found: ${POSTS_JSON} — run this from the site's repo root.`);
    process.exit(1);
  }
  if (!DRY_RUN) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const posts = JSON.parse(fs.readFileSync(POSTS_JSON, 'utf8'));
  let changed = 0;
  let failed = 0;

  for (const post of posts) {
    const { slug, cover_image } = post;
    if (!cover_image || !/^https?:\/\//i.test(cover_image)) continue; // already local, or empty

    const mdPath = path.join(POSTS_DIR, `${slug}.md`);

    let res;
    try {
      res = await fetch(cover_image);
    } catch (err) {
      console.error(`FAILED ${slug}: network error — ${err.message}`);
      failed++;
      continue;
    }
    if (!res.ok) {
      console.error(`FAILED ${slug}: HTTP ${res.status} fetching ${cover_image}`);
      failed++;
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const ext = extFromContentTypeOrUrl(contentType, cover_image);
    const localRelPath = `Media/blog-${slug}${ext}`;

    if (DRY_RUN) {
      console.log(`WOULD DOWNLOAD ${slug} -> ${localRelPath}`);
      changed++;
      continue;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(ROOT, localRelPath), buf);

    post.cover_image = localRelPath;

    if (fs.existsSync(mdPath)) {
      const mdText = fs.readFileSync(mdPath, 'utf8');
      fs.writeFileSync(mdPath, rewriteFrontmatterField(mdText, 'cover_image', localRelPath));
    } else {
      console.warn(`WARNING ${slug}: no matching ${mdPath} — only posts.json was updated`);
    }

    console.log(`OK ${slug} -> ${localRelPath}`);
    changed++;
  }

  if (!DRY_RUN && changed > 0) {
    fs.writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2) + '\n');
  }

  console.log(`\n${changed} localized, ${failed} failed, ${posts.length - changed - failed} already local/empty.`);
  if (failed > 0) process.exitCode = 1;
}

main();
