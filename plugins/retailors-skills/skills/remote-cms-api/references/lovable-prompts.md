# Prompts for briefing an app-builder platform (Lovable, Bolt, etc.)

Copy-paste-ready prompt templates for handing a dashboard build to a
separate AI app-builder tool. Fill in `YOUR-DOMAIN.com`. Hand these over
verbatim rather than summarizing the API in your own words — the exact
field names, JSON shapes, and method names matter, and a vague description
reliably produces a dashboard that doesn't quite match the real contract.

These assume the app-builder platform can call an external REST API from
its generated app — true for Lovable, Bolt, and most similar tools.

## 1. Core dashboard: page picker → table → edit dialog

```
Add a content-editing tab to this dashboard. It talks to a REST API at:
https://YOUR-DOMAIN.com/api/cms
Every request needs header  x-api-key: <the CMS_API_KEY value>  — store
this as a project secret/environment variable and route calls through a
single api() helper function, not repeated inline fetch() calls (makes it
trivial to add auth or change the header later).

Build:

1. On tab load, call GET /pages -> returns [{ "slug": "...", "label": "..." }].
   Render this as a page-picker dropdown.

2. When a page is selected, call GET /pages/:slug/content -> returns
   { "slug": "...", "fields": [ { field_key, category, type, label,
   value, preview }, ... ], "warning": "..." (optional) }.
   Render one table with columns: Category (group/badge by the
   `category` value — "SEO" or "Content"), Content (show `label` as the
   row title and `preview` as a muted subtext/second line), and an Edit
   button per row.
   If the response includes a "warning" field, show it as a small
   dismissible banner above the table (it means saves may not persist yet
   — backend still being set up).

3. Clicking Edit opens a dialog pre-filled with that row's full `value`
   (not `preview` — preview is truncated).
   - If `type` is "body", use a multi-line textarea.
   - If `type` is "title" or "link", use a single-line text input.
   - If `type` is "alt_text", use a single-line text input. This is an
     image's alt text — plain text only, NOT HTML. Add a helper note:
     "Describes the image for screen readers and search engines."
   - If `type` is "image", show a small image preview plus an input.
     IMPORTANT: render the preview from the row's `preview` field (always
     a ready-to-use absolute URL), never from `value` (which is usually a
     site-relative path like "Media/foo.jpg" and will not render). Send
     `value` back on save, not `preview`.
   - If `type` is "code", see the separate JSON-field prompt below.
   - Rows with category "Content" may contain simple inline HTML tags
     like <span>, <em>, <strong> in their value — leave any tags the
     user doesn't touch intact; add a small helper note near the field:
     "Tags like <span>...</span> control text styling — please don't
     remove them unless you mean to."

4. Saving in the dialog calls PUT /pages/:slug/content with body
   { "fields": { "<field_key>": "<edited value>" } } — send only that one
   field, keyed by the exact field_key from the row (e.g. "seo.title" or
   "block.about.hero-heading"). On success, close the dialog, show a
   success toast, and re-fetch GET /pages/:slug/content so the table
   reflects the saved value immediately.

Handle any non-2xx JSON response (they have an "error" field) by showing
it in a toast rather than failing silently.
```

## 2. JSON/structured-data field handling (`type: "code"`)

```
Add a case for field.type === "code" in the edit dialog:

1. Display: when the dialog opens for a "code" field, try to parse
   draftValue as JSON and re-stringify it with 2-space indentation
   (JSON.stringify(JSON.parse(value), null, 2)) before putting it in the
   textarea, so it's human-readable instead of one long line. If parsing
   fails (shouldn't normally happen, but be defensive), just show the
   raw value as-is rather than crashing the dialog.

2. Input: use a monospace textarea (taller than the default — 16-20 rows)
   so the JSON structure is easy to read while editing. A code-editor
   component is a nice-to-have if this project already has one available,
   not required.

3. Validation before Save: for "code" fields specifically, before calling
   the PUT request, try JSON.parse(draftValue). If it throws, don't send
   the request — show an inline error near the textarea ("Invalid JSON:
   <error message>") and keep the dialog open. Only proceed to save if it
   parses successfully.

4. What gets sent: send draftValue as typed, don't re-minify it —
   whitespace in JSON is functionally irrelevant here.

Only applies to type "code" fields — don't change behavior for "title",
"body", "image", or "link" types.
```

## 3. Tabbed layout (Page Content / On Page SEO / Structured Data)

Once the core flow works, this is a natural next step for a page-detail
view with a lot of fields — splitting the flat table by intent rather than
scrolling one long list.

```
Restructure the content tab's page-detail view (after a page is selected)
into 3 tabs instead of one flat table: "Page Content", "On Page SEO", and
"Structured Data".

Partition the fields array from GET /pages/:slug/content like this:
- Structured Data tab: fields where type === "code"
- On Page SEO tab: fields where category === "SEO" AND type !== "code"
- Page Content tab: fields where category === "Content"

"Page Content" and "On Page SEO" tabs keep the existing table + Edit
dialog behavior unchanged.

"Structured Data" tab is different: skip the table and Edit-button flow
entirely, since there's normally only one field here. Instead, render
that field's editor directly as the tab's content, immediately visible
and editable — no click-to-open-dialog step. Reuse the same code-editor
behavior from the JSON-field prompt above. Show a persistent Save button
on this tab (not inside a dialog).

Edge case: if the "code"-filtered list is empty, show a clear empty state
("No structured data field found for this page") instead of a blank tab.
If it ever contains more than one, render each with its own editor and
Save button, stacked — don't assume exactly one.

Switching tabs should preserve each tab's own draft/dirty state
independently.
```

## 4. Multi-client dashboard via the shared edge-function gateway

Use this instead of prompt 1's direct-API approach when one dashboard edits
several client sites. The browser never holds any client's API key — it
sends the logged-in user's Supabase JWT, and the edge function looks up
that client's key server-side.

```
The content editor must work across multiple client websites. Do NOT call
the client sites directly and do NOT store any per-client API key in the
frontend. Route every CMS call through our Supabase edge function
"cms-api" instead, using the logged-in user's session JWT.

Every call is a POST to the cms-api function with this envelope body:
  {
    "client_id": "<uuid of the selected client>",
    "method": "GET" | "PUT" | "DELETE",
    "path": "/pages" | "/pages/<slug>/content" | ...,
    "body": { ... }        // omit entirely for GET
  }
The function proxies it to that client's own site at
<website_url>/api/cms<path> and returns the site's JSON response verbatim.
So every path and response shape from the other prompts applies unchanged —
only the transport differs.

Build:
1. A client picker sourced from the existing clients table (only rows that
   have both website_url and cms_api_key set — others aren't configured
   for the CMS yet).
2. Store the selected client_id in the editor's state and include it in
   every envelope.
3. Wrap all of this in ONE api(clientId, method, path, body) helper.

Error handling — surface these distinctly rather than as a generic failure:
- 409 with code "not_configured" -> "This client's CMS isn't set up yet."
- 502 code "upstream_unreachable" / 504 code "upstream_timeout" ->
  "Couldn't reach the client's website." Offer a retry button.
- 403 -> the signed-in user's role isn't allowed to edit content.
```

## 5. Image fields: upload, swap, and the localization delay

```
Extend the edit dialog for fields with type "image" (this covers both the
hero photo and each content image's "— Image File" row).

1. Preview from the row's `preview` value, which is always an absolute URL.
   Never build the preview from `value`.

2. Allow replacing the image by uploading a file. Upload it to our storage
   bucket, get back the public URL, and save THAT full https:// URL as the
   field's value via the normal PUT /pages/:slug/content call.

3. After a successful save of an image field, show an informational note:
   "Image saved. It's being copied onto the website now — this usually
   takes a minute or two, and the page may briefly show a missing image
   until it finishes."
   This is expected, not an error: the website automatically downloads the
   uploaded image into its own repo and rewrites the saved value to a
   local path, so the site never depends on our storage staying up. If you
   re-fetch the field a few minutes later, `value` will have changed from
   the https:// URL you saved to a local path like "Media/cms-about-img-1.jpg".
   Treat that as normal, not as a failed save.

4. Do not add client-side validation that rejects non-https values — a
   site-relative path is the steady state for these fields.
```

## General notes when writing prompts for these tools

- Always give the exact base URL, exact header name, and exact JSON field
  names — never paraphrase the API shape and hope the platform infers it
  correctly.
- State explicitly which existing behavior should stay unchanged when
  asking for an incremental change (as in prompt 3 above) — otherwise the
  tool may regenerate more than intended.
- If something the platform builds doesn't match reality (e.g. reports a
  mismatch between what it built and what you specified), verify against
  the real API with `curl` yourself before accepting either side's account
  of what's happening — in a real build, one bug like this looked like a
  frontend mismatch but was traced to a backend bug on the API side by
  reproducing the exact request directly.
