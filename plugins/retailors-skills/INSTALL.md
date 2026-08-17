# Installing this package into a client project

These skills are designed to be **copied into each client repo**, so the
knowledge travels with the repo and anyone working on it — teammate or
agent — picks it up automatically. Nothing is installed machine-wide.

## Copy the skills into a repo

From the root of the client repo:

```bash
mkdir -p .claude/skills && cp -r /path/to/RGAdmin/plugins/retailors-skills/skills/* .claude/skills/
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force .claude\skills; Copy-Item -Recurse -Force C:\Users\marsj\Claude\RGAdmin\plugins\retailors-skills\skills\* .claude\skills\
```

Copy only what that project needs if you'd rather keep it lean — each skill
folder is self-contained:

| Folder | Copy it when |
|---|---|
| `flat-file-blog-cms` | the site has, or is getting, a markdown blog |
| `remote-cms-api` | the site has, or is getting, the dashboard-editable CMS |
| `copywriting` | you'll be writing or rewriting marketing copy there |
| `frontend-design` | you'll be doing visual/design work there |

## Copy the commands too (optional)

```bash
mkdir -p .claude/commands && cp -r /path/to/RGAdmin/plugins/retailors-skills/commands/* .claude/commands/
```

That makes `/cms-onboard` available in that project — the end-to-end runbook
for standing the stack up on a new site.

## Commit them

Commit `.claude/skills/` and `.claude/commands/` to the client repo. They're
project documentation, not local config.

## Keeping copies current

This repo (`RGAdmin/plugins/retailors-skills`) is the master. Client repos
hold snapshots. When you learn something new on a client site — a new
gotcha, a fix, a pattern — **update the master here first**, then re-copy
into the repos that need it. A fix that only ever lands in one client's
snapshot is a fix the next project won't get.

To refresh an existing copy, re-run the copy command above; it overwrites in
place.

## Alternative: install as a plugin

If you'd rather not copy folders, the same skills are published as a Claude
Code plugin from this repo's marketplace:

```
/plugin marketplace add marketing130/admin
/plugin install retailors-skills@retailors-marketplace
```

That makes them available in every project on that machine. The two
approaches are interchangeable — don't do both in the same project, or the
same skill shows up twice.
