-- CMS storage schema — MULTI-TENANT shape.
--
-- Run once in the Supabase SQL editor of the project that backs the shared
-- cms-api edge function (see references/edge-function-template.ts). ONE
-- database serves every client site; a client is a row in `clients`, not a
-- new set of tables. Onboarding a new client site does NOT require running
-- this file again — see SKILL.md's "Onboarding a new client".
--
-- READ THIS FIRST IF YOU ARE DEBUGGING A 42P10 OR A "column client_id does
-- not exist": there are two schema shapes in the wild. The original build
-- was single-tenant (`slug` as a bare primary key, no client_id at all).
-- Everything below is the multi-tenant shape the current edge function
-- requires — every one of its queries does .eq('client_id', ...). The two
-- are mutually incompatible. Confirm which one is actually deployed before
-- trusting any migration:
--
--   select table_name, column_name, data_type
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name in ('cms_pages', 'cms_blocks')
--    order by table_name, ordinal_position;
--
-- If client_id is absent, the current edge function cannot ever have worked
-- against that database — fix the schema first, don't "work around" it.
--
-- RLS is enabled with no policies defined, so only requests using the
-- service_role key (never exposed to a browser or a client-facing dashboard —
-- held server-side only, inside the edge function) can read or write these
-- tables. The anon/public key gets zero access. This is deliberate: don't add
-- a policy that opens these tables to the anon key just to make a dashboard's
-- direct-Supabase connection easier — route it through the API instead.


-- ---------------------------------------------------------------------------
-- clients — the tenant table. One row per client website.
-- ---------------------------------------------------------------------------
-- >>> CUSTOMIZE: if you already have a `clients` table (most agency
-- dashboards do), don't create a second one — just add the two CMS columns
-- to it with the ALTER below and skip the CREATE.
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- The two columns the CMS needs on whatever your clients table is called.
--   cms_api_key  — the shared secret this client's Cloudflare Worker sends as
--                  x-api-key. Resolves to exactly this client's id; every
--                  storage query is then scoped by it. Must be unique.
--   website_url  — where the gateway path proxies dashboard calls to, i.e.
--                  https://<client-domain>/api/cms/<path>.
alter table public.clients add column if not exists cms_api_key text;
alter table public.clients add column if not exists website_url text;

-- Unique so one key can never resolve to two tenants. Partial, so the many
-- clients with no CMS yet (null key) don't collide with each other.
create unique index if not exists clients_cms_api_key_key
  on public.clients (cms_api_key)
  where cms_api_key is not null;

alter table public.clients enable row level security;


-- ---------------------------------------------------------------------------
-- cms_pages — page-level SEO overrides, one row per (client, page)
-- ---------------------------------------------------------------------------
create table if not exists public.cms_pages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  slug text not null,
  title text,
  meta_description text,
  og_title text,
  og_description text,
  og_image text,
  canonical_path text,
  updated_at timestamptz not null default now()
);

-- No FK to cms_pages from cms_blocks below: a page can have content blocks
-- edited via the API before it ever gets a page-level SEO row (or without one
-- at all). See gotcha #3 in SKILL.md — this independence has to be preserved
-- on the read side too, not just here in the schema.
create table if not exists public.cms_blocks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  page_slug text not null,
  block_key text not null,
  html text not null,
  updated_at timestamptz not null default now()
);

alter table public.cms_pages enable row level security;
alter table public.cms_blocks enable row level security;


-- ---------------------------------------------------------------------------
-- Unique indexes — REQUIRED, not optional
-- ---------------------------------------------------------------------------
-- The edge function's PUT and /batch routes use
-- .upsert(..., { onConflict: 'client_id,slug' }), which compiles to
-- INSERT ... ON CONFLICT (client_id, slug) DO UPDATE. Postgres only accepts
-- that if a unique index covers EXACTLY those columns. Without these, every
-- PUT and every /batch write fails with:
--
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
--
-- Run these BEFORE deploying the function. Both are idempotent.
create unique index if not exists cms_pages_client_slug_key
  on public.cms_pages (client_id, slug);

create unique index if not exists cms_blocks_client_page_block_key
  on public.cms_blocks (client_id, page_slug, block_key);

-- The read paths always filter on (client_id, page_slug); the unique index
-- above already serves that as a left prefix, so this is only needed if you
-- ever drop it.
-- create index if not exists cms_blocks_client_page_idx
--   on public.cms_blocks (client_id, page_slug);


-- ---------------------------------------------------------------------------
-- Onboarding one new client site
-- ---------------------------------------------------------------------------
-- This is the whole database-side setup for a new site. Generate a long
-- random key, store it here, and set the SAME value as the CMS_API_KEY
-- Cloudflare secret on that client's Worker.
--
--   insert into public.clients (name, website_url, cms_api_key)
--   values ('Client Name', 'https://client-domain.com', '<long-random-string>')
--   on conflict do nothing;
--
-- Or, for a client row that already exists:
--
--   update public.clients
--      set website_url = 'https://client-domain.com',
--          cms_api_key = '<long-random-string>'
--    where id = '<client-uuid>';
--
-- Key changes take up to 60s to take effect (the edge function caches the
-- key -> client_id lookup per isolate; see makeCache in
-- edge-function-template.ts).
