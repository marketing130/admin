# Retailors Skills for Claude Code

Shared [Claude Code](https://claude.com/claude-code) skills used by the Retailors Group team. Install them once and Claude will use them automatically when a task matches.

## Included skills

| Skill | What it does |
|-------|--------------|
| **copywriting** | Write, rewrite, and improve marketing copy for homepages, landing, pricing, feature, about, and product pages. |
| **flat-file-blog-cms** | Add a lightweight, database-free blog to a static HTML site — a JSON index plus one markdown file per post, rendered client-side. No backend, no build step. |
| **remote-cms-api** | Add a remote content/SEO editing REST API (a lightweight CMS) to a static site on Cloudflare Workers, so page text and meta tags can be edited without redeploying. |

## Install (recommended — plugin marketplace)

From inside Claude Code:

```
/plugin marketplace add marketing130/admin
/plugin install retailors-skills@retailors-marketplace
```

Then restart Claude Code if prompted. The skills activate on their own when your request matches one of their descriptions.

## Install (manual — copy the folders)

If you'd rather not use the plugin system, copy the skill folders into your Claude skills directory.

Personal (available in every project):

```bash
git clone https://github.com/marketing130/admin.git
cp -r admin/plugins/retailors-skills/skills/* ~/.claude/skills/
```

Or per-project (available only in one repo), copy them into that project's `.claude/skills/` instead.

On Windows, `~/.claude/skills/` is `%USERPROFILE%\.claude\skills\`.

## Updating

- **Marketplace install:** `/plugin marketplace update retailors-marketplace`
- **Manual install:** re-run the `git clone` + `cp` steps above.

## Repo layout

```
.claude-plugin/marketplace.json      marketplace definition
plugins/retailors-skills/
  .claude-plugin/plugin.json         plugin definition
  skills/
    copywriting/
    flat-file-blog-cms/
    remote-cms-api/
```

## Notes

- Each skill lives in its own folder with a `SKILL.md` and supporting `references/`. Templates use placeholders (e.g. `CMS_API_KEY`, `YOUR-PROJECT.supabase.co`) — no real secrets or client data.
- The team's `frontend-design` skill is **not** included here: it is authored by Anthropic and its license does not permit redistribution. Get it through Anthropic directly.
