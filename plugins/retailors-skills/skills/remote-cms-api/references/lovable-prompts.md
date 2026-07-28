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
   - If `type` is "image", show a small image preview of the current
     value plus a URL text input.
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
