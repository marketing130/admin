# Retailors Skills for Claude Code

Shared [Claude Code](https://claude.com/claude-code) skills used by the Retailors Group team. Install them once and Claude will use them automatically when a task matches.

## Included skills

| Skill | What it does |
|-------|--------------|
| **copywriting** | Write, rewrite, and improve marketing copy for homepages, landing, pricing, feature, about, and product pages. |
| **flat-file-blog-cms** | Add a lightweight, database-free blog to a static HTML site — a JSON index plus one markdown file per post, rendered client-side. No backend, no build step. |
| **remote-cms-api** | Add a remote content/SEO editing REST API (a lightweight CMS) to a static site on Cloudflare Workers, so page text, images, and meta tags can be edited without redeploying. Multi-tenant: one shared backend and one dashboard serve every client site. |

## Included commands

| Command | What it does |
|---------|--------------|
| **`/cms-onboard`** | End-to-end runbook for standing the blog and/or CMS up on a new client site: survey → blog → Worker + retrofit → optional pipelines → curl verification. |

Prefer to paste a brief instead? [prompts/new-site-cms-kickoff.md](plugins/retailors-skills/prompts/new-site-cms-kickoff.md) has fill-in-the-blanks kickoff prompts for the same job — full stack, blog-only, and adding the optional pipelines later.

## Install (recommended — plugin marketplace)

From inside Claude Code:

```
/plugin marketplace add marketing130/admin
/plugin install retailors-skills@retailors-marketplace
```

Then restart Claude Code if prompted. The skills activate on their own when your request matches one of their descriptions.

## Install (manual — copy the folders)

If you'd rather not use the plugin system, copy the skill folders into a project. See [INSTALL.md](plugins/retailors-skills/INSTALL.md) for the full per-project workflow, including which skills to copy for which kind of project and how to keep copies current.

Per-project (available only in one repo) — this is what the team does by default, so the knowledge travels with the client repo:

```bash
git clone https://github.com/marketing130/admin.git
mkdir -p .claude/skills .claude/commands
cp -r admin/plugins/retailors-skills/skills/* .claude/skills/
cp -r admin/plugins/retailors-skills/commands/* .claude/commands/
```

Personal (available in every project on that machine):

```bash
cp -r admin/plugins/retailors-skills/skills/* ~/.claude/skills/
```

On Windows, `~/.claude/skills/` is `%USERPROFILE%\.claude\skills\`.

## Updating

- **Marketplace install:** `/plugin marketplace update retailors-marketplace`
- **Manual install:** re-run the `git clone` + `cp` steps above.

This repo is the master copy. When you learn something new on a client site, update it here first, then re-copy into the client repos that need it — a fix that only lands in one project's snapshot is a fix the next project won't get.

## Repo layout

```
.claude-plugin/marketplace.json      marketplace definition
plugins/retailors-skills/
  .claude-plugin/plugin.json         plugin definition
  INSTALL.md                         per-project install + upkeep guide
  commands/
    cms-onboard.md                   /cms-onboard runbook
  prompts/
    new-site-cms-kickoff.md          paste-ready kickoff prompts for a new site
  skills/
    copywriting/
    flat-file-blog-cms/
    remote-cms-api/
```

## Notes

- Each skill lives in its own folder with a `SKILL.md` and supporting `references/`. Templates use placeholders (e.g. `CMS_API_KEY`, `YOUR-PROJECT.supabase.co`, `YOUR-CLIENT-DOMAIN.com`) — no real secrets or client data.
- The team's `frontend-design` skill is **not** included here: it is authored by Anthropic and its license does not permit redistribution. Get it through Anthropic directly.
