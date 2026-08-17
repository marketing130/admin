#!/usr/bin/env node
/* Downloads one CMS content-image's remote URL into Media/ and reports the
   local path via $GITHUB_OUTPUT (local_path), for the "Commit and push" /
   "Save local path back to the CMS" steps in
   localize-cms-image-workflow.yml to use.

   Companion to the flat-file-blog-cms skill's localize-cover-images.js — same
   never-depend-on-external-hosting rationale, different trigger. Blog posts
   arrive as a git push, so a push-triggered workflow catches them for free.
   CMS image edits land in the database instead, so the trigger has to be a
   database webhook -> the Worker -> repository_dispatch. See SKILL.md's
   "Content image auto-localization" section for the full pipeline.

   Requires Node 18+ (built-in fetch). No dependencies.

   Reads IMAGE_URL / PAGE_SLUG / BLOCK_KEY from the environment (set by the
   workflow from the repository_dispatch client_payload).

   >>> CUSTOMIZE: MEDIA_DIR if this client's images don't live in Media/. */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const MEDIA_DIR = path.join(ROOT, 'Media');

function extFromContentTypeOrUrl(contentType, url) {
  const ctMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };
  if (contentType && ctMap[contentType.split(';')[0].trim()]) return ctMap[contentType.split(';')[0].trim()];
  const m = url.match(/\.(jpe?g|png|webp|gif|svg)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

// "about.img-1-src" -> "about-img-1" — a deterministic filename so re-editing
// the same field overwrites its own file instead of accumulating orphaned
// images in Media/ forever.
function filenameBaseFor(blockKey) {
  return blockKey.replace(/-src$/, '').replace(/\./g, '-');
}

async function main() {
  const imageUrl = process.env.IMAGE_URL;
  const pageSlug = process.env.PAGE_SLUG;
  const blockKey = process.env.BLOCK_KEY;

  if (!imageUrl || !pageSlug || !blockKey) {
    console.error('IMAGE_URL, PAGE_SLUG, and BLOCK_KEY environment variables are all required.');
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    console.error(`IMAGE_URL is not a remote URL, nothing to localize: ${imageUrl}`);
    process.exit(1);
  }

  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  let res;
  try {
    res = await fetch(imageUrl);
  } catch (err) {
    console.error(`FAILED: network error fetching ${imageUrl} — ${err.message}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`FAILED: HTTP ${res.status} fetching ${imageUrl}`);
    process.exit(1);
  }

  const contentType = res.headers.get('content-type') || '';
  const ext = extFromContentTypeOrUrl(contentType, imageUrl);
  const localRelPath = `Media/cms-${filenameBaseFor(blockKey)}${ext}`;

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(ROOT, localRelPath), buf);

  console.log(`OK ${pageSlug}/${blockKey} -> ${localRelPath}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `local_path=${localRelPath}\n`);
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
