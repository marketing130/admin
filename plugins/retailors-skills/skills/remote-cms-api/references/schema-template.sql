-- Run once in the Supabase SQL editor for whichever project backs this
-- client's CMS API (see references/worker-template.js). Creates the two
-- tables the /api/cms/* REST API reads and writes.
--
-- This schema works whether the Worker talks to Supabase directly (with a
-- service_role key) or via an edge-function proxy — the edge function just
-- needs to be pointed at these same table/column names. If the client's
-- backend is managed by an app-builder platform, have IT run this
-- migration against its connected Supabase project rather than assuming
-- you have direct SQL editor access yourself.
--
-- RLS is enabled with no policies defined, so only requests using the
-- service_role key (never exposed to a browser or a client-facing
-- dashboard — held server-side only, either as a Worker secret or inside
-- an edge function) can read or write these tables. The anon/public key
-- gets zero access. This is deliberate: don't add a policy that opens
-- these tables to the anon key just to make a dashboard's direct-Supabase
-- connection easier — route it through the API instead.

create table if not exists public.cms_pages (
  slug text primary key,
  title text,
  meta_description text,
  og_title text,
  og_description text,
  og_image text,
  canonical_path text,
  updated_at timestamptz not null default now()
);

-- No FK to cms_pages: a page can have content blocks edited via the API
-- before it ever gets a page-level SEO row (or without one at all). See
-- gotcha #3 in SKILL.md — this independence needs to be preserved on the
-- read side too, not just here in the schema.
create table if not exists public.cms_blocks (
  page_slug text not null,
  block_key text not null,
  html text not null,
  updated_at timestamptz not null default now(),
  primary key (page_slug, block_key)
);

alter table public.cms_pages enable row level security;
alter table public.cms_blocks enable row level security;
