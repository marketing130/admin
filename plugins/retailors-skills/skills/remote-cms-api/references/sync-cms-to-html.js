#!/usr/bin/env node
/* Bakes one page's saved CMS overrides into its actual .html file, so the
   repo — not the database — stays the source of truth for site content.

   Without this, a dashboard save only ever lives in the database: the Worker
   layers it over the static file at request time (see applyCmsOverrides in
   worker-template.js), so the file and the live page drift apart and
   hand-editing the HTML silently stops working. That drift is invisible
   until someone edits a heading in the repo, deploys, and nothing changes.

   Runs in two modes, as two steps of sync-cms-to-html-workflow.yml with the
   commit+push in between:

     MODE=apply     Reads the page's page/block override rows, writes each
                    value into the markup exactly the way the Worker's
                    HTMLRewriter would render it, and records what it wrote
                    in $SNAPSHOT_FILE.
     MODE=finalize  Polls GET .../defaults (the un-merged view of the
                    DEPLOYED file) until it reports the values from the
                    snapshot, then clears those rows — at which point the
                    file is what the live page serves.

   Clearing rows only after the deploy is confirmed is the whole point of the
   two-step split: delete them any earlier and the page reverts to the
   pre-edit text for however long the deploy takes.

   Requires Node 18+ (built-in fetch). No dependencies.

   Reads PAGE_SLUG / CMS_API_KEY / SNAPSHOT_FILE from the environment, plus
   optional MODE (default "apply") and SITE_ORIGIN.

   >>> CUSTOMIZE: the SITE_ORIGIN default below, and fileForSlug() if this
   client's pages don't live as <slug>.html at the repo root. */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://YOUR-CLIENT-DOMAIN.com';

// The Worker's SEO field -> markup mapping, mirrored. Keep this in the same
// order as the HTMLRewriter handler chain in applyCmsOverrides so the two can
// be diffed by eye when either side changes. If you add a field to one and
// not the other, the symptom is a value that syncs to the database but never
// makes it into the file (and so never gets cleared).
const SEO_TARGETS = {
  title: [{ kind: 'title' }],
  meta_description: [{ kind: 'meta', attr: 'name', value: 'description' }],
  og_title: [
    { kind: 'meta', attr: 'property', value: 'og:title' },
    { kind: 'meta', attr: 'name', value: 'twitter:title' },
  ],
  og_description: [
    { kind: 'meta', attr: 'property', value: 'og:description' },
    { kind: 'meta', attr: 'name', value: 'twitter:description' },
  ],
  og_image: [
    { kind: 'meta', attr: 'property', value: 'og:image' },
    { kind: 'meta', attr: 'name', value: 'twitter:image' },
  ],
  canonical_path: [
    { kind: 'meta', attr: 'property', value: 'og:url' },
    { kind: 'canonical' },
  ],
};

// Poll budget for the deploy: Cloudflare usually publishes a pushed commit in
// a minute or two, but a queued build can take longer, and waiting is always
// cheaper than clearing a row too early.
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// HTMLRewriter's setInnerContent(value) (no { html: true }) and setAttribute()
// both entity-escape what they're given. Matching that here matters for more
// than looking right: the finalize step compares what we wrote against what
// the deployed file parses back to, so "&" has to become "&amp;" on the way
// in or the two never line up and the job times out waiting for a deploy that
// already landed.
const escapeText = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (v) => escapeText(v).replace(/"/g, '&quot;');

function fileForSlug(slug) {
  return path.join(ROOT, `${slug}.html`);
}

async function cmsRequest(pathname, options = {}) {
  const res = await fetch(`${SITE_ORIGIN}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'x-api-key': process.env.CMS_API_KEY || '',
      'Content-Type': 'application/json',
    },
    body: options.body,
  });
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ---- Writing a value into the markup ------------------------------------
// One helper per shape the Worker's BlockHandler can produce, so the file
// ends up byte-identical to what a page view would have rendered.

function setAttribute(openTag, name, value) {
  const existing = new RegExp(`\\s${name}="[^"]*"`);
  if (existing.test(openTag)) {
    return openTag.replace(existing, ` ${name}="${escapeAttr(value)}"`);
  }
  return openTag.replace(/\s*\/?>$/, (end) => ` ${name}="${escapeAttr(value)}"${end}`);
}

function findOpenTag(html, key) {
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\sdata-cms-id="${escapeRegExp(key)}"[^>]*>`);
  const match = re.exec(html);
  return match ? { full: match[0], tag: match[1].toLowerCase(), index: match.index } : null;
}

function replaceOpenTag(html, found, newTag) {
  return html.slice(0, found.index) + newTag + html.slice(found.index + found.full.length);
}

// Returns { html, fileValue } — fileValue being what the deployed file should
// parse back to once this lands, i.e. what finalize waits for. A null return
// means the key has no home in this file and must NOT be cleared from the
// database (that would drop the content entirely).
function applyBlock(html, blockKey, value) {
  // `<key>-src` isn't its own data-cms-id — the Worker derives it from the
  // sibling `-alt` key at render time, so resolve it the same way here.
  if (blockKey.endsWith('-src')) {
    const altKey = `${blockKey.slice(0, -'-src'.length)}-alt`;
    const found = findOpenTag(html, altKey);
    if (!found || found.tag !== 'img') return null;
    return { html: replaceOpenTag(html, found, setAttribute(found.full, 'src', value)), fileValue: escapeAttr(value) };
  }

  const found = findOpenTag(html, blockKey);
  if (!found) return null;

  // <img> is void — its editable value is the alt attribute.
  if (found.tag === 'img') {
    return { html: replaceOpenTag(html, found, setAttribute(found.full, 'alt', value)), fileValue: escapeAttr(value) };
  }

  // Hero sections carry their photo as a background-image in `style`. Swap
  // just the url(...) and leave the gradient overlay (and the rest of the
  // already-escaped attribute) exactly as-is — hence editing the tag text
  // directly instead of going through setAttribute, which would re-escape
  // everything else in there.
  const styleMatch = found.full.match(/\sstyle="([^"]*)"/);
  if (styleMatch && /url\(/.test(styleMatch[1])) {
    const newTag = found.full.replace(
      /(\sstyle=")([^"]*)(")/,
      (_m, open, style, close) => open + style.replace(/url\(['"]?[^'")]*['"]?\)/, `url('${escapeAttr(value)}')`) + close,
    );
    return { html: replaceOpenTag(html, found, newTag), fileValue: escapeAttr(value) };
  }

  // Everything else: replace the element's inner content. Bounded to the
  // first matching close tag, the same assumption extractBlockDefaults makes
  // (these are leaf elements that never nest a same-named tag).
  const innerRe = new RegExp(
    `(<${found.tag}\\b[^>]*\\sdata-cms-id="${escapeRegExp(blockKey)}"[^>]*>)([\\s\\S]*?)(</${found.tag}>)`,
  );
  if (!innerRe.test(html)) return null;
  return { html: html.replace(innerRe, (_m, open, _inner, close) => `${open}${value}${close}`), fileValue: value.trim() };
}

function applySeo(html, field, value) {
  const targets = SEO_TARGETS[field];
  if (!targets) return null;

  let out = html;
  let hit = false;
  // What extractSeoDefaults will read back for this field: <title>'s inner
  // text for the title, an attribute value for every other one.
  const fileValue = field === 'title' ? escapeText(value) : escapeAttr(value);

  for (const target of targets) {
    if (target.kind === 'title') {
      if (!/<title>[\s\S]*?<\/title>/.test(out)) continue;
      out = out.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeText(value)}</title>`);
      hit = true;
      continue;
    }

    const re = target.kind === 'canonical'
      ? /<link\b[^>]*\srel="canonical"[^>]*>/i
      : new RegExp(`<meta\\b[^>]*\\s${target.attr}="${escapeRegExp(target.value)}"[^>]*>`, 'i');
    const match = re.exec(out);
    if (!match) continue;

    const attr = target.kind === 'canonical' ? 'href' : 'content';
    out = out.slice(0, match.index) + setAttribute(match[0], attr, value) + out.slice(match.index + match[0].length);
    hit = true;
  }

  return hit ? { html: out, fileValue } : null;
}

// ---- MODE=apply ----------------------------------------------------------

async function apply(slug) {
  const filePath = fileForSlug(slug);
  if (!fs.existsSync(filePath)) {
    console.error(`FAILED: no HTML file for slug "${slug}" (looked for ${path.relative(ROOT, filePath)})`);
    process.exit(1);
  }

  const [page, blocks] = await Promise.all([
    cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}`),
    cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}/blocks`),
  ]);

  const original = fs.readFileSync(filePath, 'utf8');
  let html = original;
  const snapshot = { slug, seo: {}, blocks: {} };
  const skipped = [];

  for (const row of Array.isArray(blocks) ? blocks : []) {
    if (typeof row.block_key !== 'string' || typeof row.html !== 'string') continue;
    const result = applyBlock(html, row.block_key, row.html);
    if (!result) {
      // A stale block key (renamed/removed data-cms-id) must never be
      // cleared — that would silently drop the client's content.
      skipped.push(`block ${row.block_key} (no matching data-cms-id in the file)`);
      continue;
    }
    html = result.html;
    snapshot.blocks[row.block_key] = { rowValue: row.html, fileValue: result.fileValue };
  }

  for (const [field, value] of Object.entries(page || {})) {
    if (!SEO_TARGETS[field] || typeof value !== 'string' || value === '') continue;
    const result = applySeo(html, field, value);
    if (!result) {
      skipped.push(`seo.${field} (no matching tag in the file)`);
      continue;
    }
    html = result.html;
    snapshot.seo[field] = { rowValue: value, fileValue: result.fileValue };
  }

  const changed = html !== original;
  if (changed) fs.writeFileSync(filePath, html);

  const count = Object.keys(snapshot.blocks).length + Object.keys(snapshot.seo).length;
  console.log(changed
    ? `OK ${slug}: wrote ${count} override(s) into ${path.relative(ROOT, filePath)}`
    : `OK ${slug}: ${count} override(s) already match ${path.relative(ROOT, filePath)} — nothing to commit`);
  for (const note of skipped) console.warn(`  skipped ${note} — leaving the row in place`);

  if (process.env.SNAPSHOT_FILE) {
    fs.writeFileSync(process.env.SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nsynced=${count}\n`);
  }
}

// ---- MODE=finalize -------------------------------------------------------

async function finalize(slug) {
  const snapshotPath = process.env.SNAPSHOT_FILE;
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error('FAILED: SNAPSHOT_FILE is required in finalize mode and must exist.');
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

  const wanted = [
    ...Object.entries(snapshot.blocks).map(([key, v]) => ({ type: 'block', key, ...v })),
    ...Object.entries(snapshot.seo).map(([key, v]) => ({ type: 'seo', key, ...v })),
  ];
  if (!wanted.length) {
    console.log(`OK ${slug}: nothing was baked, nothing to clear.`);
    return;
  }

  let deployed = null;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    deployed = await cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}/defaults`);
    const pending = wanted.filter((w) => {
      const live = w.type === 'block' ? deployed.blocks[w.key] : deployed.seo[w.key];
      return (live == null ? '' : String(live).trim()) !== w.fileValue.trim();
    });
    if (!pending.length) break;
    if (attempt === POLL_ATTEMPTS) {
      console.error(`FAILED: ${pending.length} value(s) still not live after ${(POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60000} minutes:`);
      for (const p of pending) console.error(`  ${p.type}.${p.key}`);
      console.error('Overrides were left in place, so the live site is unaffected — re-run this workflow once the deploy lands.');
      process.exit(1);
    }
    console.log(`Waiting for deploy — ${pending.length} value(s) not live yet (attempt ${attempt}/${POLL_ATTEMPTS})`);
    await sleep(POLL_INTERVAL_MS);
  }

  // Re-read the rows right before clearing: an edit saved while this job was
  // running has its own sync run queued, and deleting it here would throw
  // that edit away.
  const [page, blocks] = await Promise.all([
    cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}`),
    cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}/blocks`),
  ]);
  const current = new Map((Array.isArray(blocks) ? blocks : []).map((b) => [b.block_key, b.html]));

  let cleared = 0;
  let superseded = 0;

  for (const [key, { rowValue }] of Object.entries(snapshot.blocks)) {
    if (!current.has(key)) continue;
    if (current.get(key) !== rowValue) { superseded++; continue; }
    await cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(key)}`, { method: 'DELETE' });
    cleared++;
  }

  // SEO lives in columns on one page row, so "clearing" is nulling the fields
  // that got baked — the Worker treats null as "no override" and falls back
  // to the file.
  const seoNulls = {};
  for (const [field, { rowValue }] of Object.entries(snapshot.seo)) {
    if (!page || page[field] !== rowValue) { superseded++; continue; }
    seoNulls[field] = null;
  }
  if (Object.keys(seoNulls).length) {
    await cmsRequest(`/api/cms/pages/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(seoNulls) });
    cleared += Object.keys(seoNulls).length;
  }

  console.log(`OK ${slug}: deploy confirmed, cleared ${cleared} override(s) — the HTML file is the source of truth again.`);
  if (superseded) console.log(`  left ${superseded} override(s) alone — edited again while this ran, a follow-up sync will handle them.`);
}

async function main() {
  const slug = process.env.PAGE_SLUG;
  if (!slug) {
    console.error('PAGE_SLUG environment variable is required.');
    process.exit(1);
  }
  const mode = process.env.MODE || 'apply';
  if (mode === 'apply') return apply(slug);
  if (mode === 'finalize') return finalize(slug);
  console.error(`Unknown MODE "${mode}" — expected "apply" or "finalize".`);
  process.exit(1);
}

// Exported so the markup transforms can be exercised directly against a real
// page file without a CMS round trip; running the file still syncs.
module.exports = { applyBlock, applySeo, escapeText, escapeAttr };

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  });
}
