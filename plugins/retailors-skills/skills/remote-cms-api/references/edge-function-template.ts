// Supabase Edge Function: cms-api
//
// THE SHARED, MULTI-TENANT BACKEND. Read this before assuming a new client
// needs their own copy — they almost certainly don't. One deployment of this
// function serves every client site; onboarding a new one is a row in
// `clients`, not a new function. See SKILL.md's "Onboarding a new client"
// section.
//
// Two entry paths, distinguished by headers:
//   STORAGE  — `x-api-key` present. Server-to-server from a client's
//              Cloudflare Worker. The key resolves to exactly one client via
//              clients.cms_api_key; every query is then scoped by that id,
//              so one client can never read or write another's rows.
//   GATEWAY  — Supabase user JWT. Called by the internal dashboard with an
//              envelope { client_id, method, path, body }; proxies to that
//              client's own site at <website_url>/api/cms/<path> using the
//              stored key. This is what lets one dashboard edit N sites
//              without the browser ever holding any client's API key.
//
// DEPLOY NOTE (costs an hour if missed): the storage path sends no
// Authorization header, so this function MUST be deployed with JWT
// verification disabled, otherwise the platform rejects every Worker call
// with a 401 before this code ever runs:
//   supabase functions deploy cms-api --no-verify-jwt
// (or `verify_jwt = false` under [functions.cms-api] in config.toml).
//
// See schema-template.sql for the tables and — critically — the unique
// indexes the upsert routes below require.

import { createClient } from 'npm:@supabase/supabase-js@2'

// NOTE: @supabase/supabase-js has no `/cors` subpath export. Importing one
// fails module resolution at boot and 503s every invocation, so CORS headers
// are declared literally here.
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  // Without this the dashboard preflights every single request, doubling
  // round trips for browser-originated calls.
  'Access-Control-Max-Age': '86400',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// persistSession/autoRefreshToken do nothing useful in an edge isolate and
// cost storage probes on every client construction.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

const PAGE_FIELDS = [
  'title',
  'meta_description',
  'og_title',
  'og_description',
  'og_image',
  'canonical_path',
] as const

const UPSTREAM_TIMEOUT_MS = 15_000

// -----------------------------------------------------------------------------
// Isolate-local caches. Supabase reuses an isolate across many invocations, so
// these turn the per-request `clients` / `user_roles` lookups into a round trip
// that only happens once per TTL instead of once per request.
// -----------------------------------------------------------------------------
type CacheEntry<T> = { value: T; expires: number }

function makeCache<T>(ttlMs: number) {
  const store = new Map<string, CacheEntry<T>>()
  return {
    get(key: string): T | undefined {
      const hit = store.get(key)
      if (!hit) return undefined
      if (hit.expires < Date.now()) {
        store.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key: string, value: T) {
      // Bounded so a key-guessing flood can't grow this without limit.
      if (store.size > 500) store.clear()
      store.set(key, { value, expires: Date.now() + ttlMs })
    },
  }
}

// TTLs are the staleness budget for each lookup: rotating a client's
// cms_api_key or changing its website_url takes up to 60s to take effect, and
// revoking a user's role takes up to 15s. Lower them if that's too long.
const apiKeyCache = makeCache<string | null>(60_000)
const clientRowCache = makeCache<{ website_url: string; cms_api_key: string } | null>(60_000)
const rolesCache = makeCache<string[]>(15_000)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Pass an already-serialized JSON string through without a parse/stringify round trip. */
function rawJson(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function errCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

/** 23505 = unique_violation. Anything else from Postgres is a genuine 500. */
function dbError(error: unknown) {
  const code = errCode(error)
  const message = (error as { message?: string } | null)?.message ?? 'Database error'
  return json({ error: message, code }, code === '23505' ? 409 : 500)
}

function normalizeWebsiteUrl(raw: string): string {
  let u = (raw || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u.replace(/\/+$/, '')
}

function pickPageFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PAGE_FIELDS) if (k in body) out[k] = body[k]
  return out
}

const nowIso = () => new Date().toISOString()

// -----------------------------------------------------------------------------
// STORAGE PATH — called by a client site's Cloudflare Worker
// -----------------------------------------------------------------------------
async function resolveClientId(apiKey: string): Promise<string | null> {
  const cached = apiKeyCache.get(apiKey)
  if (cached !== undefined) return cached

  const { data, error } = await admin
    .from('clients')
    .select('id')
    .eq('cms_api_key', apiKey)
    .maybeSingle()
  if (error) throw error

  const id = (data as { id?: string } | null)?.id ?? null
  // Negative results are cached too, so a hammering bad key costs one query
  // per minute rather than one per request.
  apiKeyCache.set(apiKey, id)
  return id
}

async function handleStorage(req: Request, apiKey: string): Promise<Response> {
  const clientId = await resolveClientId(apiKey)
  if (!clientId) return json({ error: 'Unauthorized: unknown x-api-key' }, 401)

  const url = new URL(req.url)
  // Strip the function mount prefix so routes below read as /pages, /blocks, …
  let path = url.pathname.replace(/^(?:\/functions\/v1)?\/cms-api/, '')
  if (!path.startsWith('/')) path = '/' + path
  path = path.replace(/\/+$/, '') || '/'
  const method = req.method.toUpperCase()

  const readBody = async (): Promise<Record<string, unknown>> => {
    const text = await req.text()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  if (path === '/health') return json({ ok: true, client_id: clientId })

  // ---------- /pages ----------
  if (path === '/pages') {
    if (method === 'GET') {
      const { data, error } = await admin
        .from('cms_pages')
        .select(
          'slug, title, meta_description, og_title, og_description, og_image, canonical_path, updated_at',
        )
        .eq('client_id', clientId)
      if (error) return dbError(error)
      return json({ pages: data ?? [] })
    }

    // Kept for backwards compatibility with callers that create-then-update
    // (see backendUpsert in worker-template.js). New callers should use
    // PUT /pages/:slug, which is a single upsert.
    if (method === 'POST') {
      const body = await readBody()
      if (!body.slug || typeof body.slug !== 'string') {
        return json({ error: 'slug is required' }, 400)
      }
      const row = { client_id: clientId, slug: body.slug, ...pickPageFields(body) }
      const { data, error } = await admin.from('cms_pages').insert(row).select().single()
      if (error) return dbError(error)
      return json({ page: data }, 201)
    }
  }

  // ---------- /pages/:slug ----------
  const pageMatch = path.match(/^\/pages\/([^/]+)$/)
  if (pageMatch) {
    const slug = decodeURIComponent(pageMatch[1])

    if (method === 'GET') {
      // Independent queries — issue them together instead of back to back.
      // NOTE: this route 404s when there's no page-level SEO row, even if the
      // page has block overrides. That's why the Worker never relies on this
      // combined response alone (gotcha #3).
      const [pageRes, blockRes] = await Promise.all([
        admin
          .from('cms_pages')
          .select('*')
          .eq('client_id', clientId)
          .eq('slug', slug)
          .maybeSingle(),
        admin
          .from('cms_blocks')
          .select('page_slug, block_key, html, updated_at')
          .eq('client_id', clientId)
          .eq('page_slug', slug),
      ])
      if (pageRes.error) return dbError(pageRes.error)
      if (!pageRes.data) return json({ error: 'Not found' }, 404)
      if (blockRes.error) return dbError(blockRes.error)
      return json({ page: pageRes.data, blocks: blockRes.data ?? [] })
    }

    // PUT = upsert. This is the route callers should use for saves: one round
    // trip whether or not the row exists, and it never returns a 404/409 that
    // the caller has to "recover" from with a second write.
    if (method === 'PUT') {
      const body = await readBody()
      const row = {
        client_id: clientId,
        slug,
        ...pickPageFields(body),
        updated_at: nowIso(),
      }
      const { data, error } = await admin
        .from('cms_pages')
        .upsert(row, { onConflict: 'client_id,slug' })
        .select()
        .single()
      if (error) return dbError(error)
      return json({ page: data })
    }

    if (method === 'PATCH') {
      const body = await readBody()
      const patch = { ...pickPageFields(body), updated_at: nowIso() }
      const { data, error } = await admin
        .from('cms_pages')
        .update(patch)
        .eq('client_id', clientId)
        .eq('slug', slug)
        .select()
        .maybeSingle()
      if (error) return dbError(error)
      if (!data) return json({ error: 'Not found' }, 404)
      return json({ page: data })
    }
  }

  // ---------- /pages/:slug/batch ----------
  // Writes a page's SEO row and any number of blocks in two parallel queries,
  // regardless of how many fields changed. Replaces N sequential invocations
  // from the caller with one.
  const batchMatch = path.match(/^\/pages\/([^/]+)\/batch$/)
  if (batchMatch && (method === 'POST' || method === 'PUT')) {
    const slug = decodeURIComponent(batchMatch[1])
    const body = await readBody()

    const pagePatch = pickPageFields((body.page as Record<string, unknown>) ?? {})
    const rawBlocks = Array.isArray(body.blocks) ? body.blocks : []
    const blockRows: Record<string, unknown>[] = []
    for (const b of rawBlocks as Record<string, unknown>[]) {
      if (!b || typeof b.block_key !== 'string' || typeof b.html !== 'string') {
        return json({ error: 'each block needs a string block_key and html' }, 400)
      }
      blockRows.push({
        client_id: clientId,
        page_slug: slug,
        block_key: b.block_key,
        html: b.html,
        updated_at: nowIso(),
      })
    }

    if (!Object.keys(pagePatch).length && !blockRows.length) {
      return json({ error: 'nothing to write: send page fields and/or blocks' }, 400)
    }

    const [pageRes, blockRes] = await Promise.all([
      Object.keys(pagePatch).length
        ? admin
            .from('cms_pages')
            .upsert(
              { client_id: clientId, slug, ...pagePatch, updated_at: nowIso() },
              { onConflict: 'client_id,slug' },
            )
            .select()
            .single()
        : Promise.resolve({ data: null, error: null }),
      blockRows.length
        ? admin
            .from('cms_blocks')
            .upsert(blockRows, { onConflict: 'client_id,page_slug,block_key' })
            .select('page_slug, block_key, html, updated_at')
        : Promise.resolve({ data: [], error: null }),
    ])
    if (pageRes.error) return dbError(pageRes.error)
    if (blockRes.error) return dbError(blockRes.error)
    return json({ page: pageRes.data, blocks: blockRes.data ?? [] })
  }

  // ---------- /blocks ----------
  if (path === '/blocks') {
    if (method === 'GET') {
      const pageSlug = url.searchParams.get('page_slug')
      if (!pageSlug) return json({ error: 'page_slug is required' }, 400)
      const { data, error } = await admin
        .from('cms_blocks')
        .select('page_slug, block_key, html, updated_at')
        .eq('client_id', clientId)
        .eq('page_slug', pageSlug)
      if (error) return dbError(error)
      return json({ blocks: data ?? [] })
    }

    // Backwards compatible create-only path; prefer PUT /blocks/:slug/:key.
    if (method === 'POST') {
      const body = await readBody()
      if (
        typeof body.page_slug !== 'string' ||
        typeof body.block_key !== 'string' ||
        typeof body.html !== 'string'
      ) {
        return json({ error: 'page_slug, block_key, and html are required' }, 400)
      }
      const { data, error } = await admin
        .from('cms_blocks')
        .insert({
          client_id: clientId,
          page_slug: body.page_slug,
          block_key: body.block_key,
          html: body.html,
        })
        .select()
        .single()
      if (error) return dbError(error)
      return json({ block: data }, 201)
    }
  }

  // ---------- /blocks/:pageSlug/:blockKey ----------
  // NOTE: blockKey is matched VERBATIM against the stored block_key — it is
  // never combined with :pageSlug. Since block keys are stored slug-prefixed
  // ("about.hero-heading"), the segment must be the full prefixed form too.
  const blockMatch = path.match(/^\/blocks\/([^/]+)\/([^/]+)$/)
  if (blockMatch) {
    const pageSlug = decodeURIComponent(blockMatch[1])
    const blockKey = decodeURIComponent(blockMatch[2])

    if (method === 'GET') {
      const { data, error } = await admin
        .from('cms_blocks')
        .select('page_slug, block_key, html, updated_at')
        .eq('client_id', clientId)
        .eq('page_slug', pageSlug)
        .eq('block_key', blockKey)
        .maybeSingle()
      if (error) return dbError(error)
      if (!data) return json({ error: 'Not found' }, 404)
      return json({ block: data })
    }

    if (method === 'PUT') {
      const body = await readBody()
      if (typeof body.html !== 'string') return json({ error: 'html is required' }, 400)
      const { data, error } = await admin
        .from('cms_blocks')
        .upsert(
          {
            client_id: clientId,
            page_slug: pageSlug,
            block_key: blockKey,
            html: body.html,
            updated_at: nowIso(),
          },
          { onConflict: 'client_id,page_slug,block_key' },
        )
        .select()
        .single()
      if (error) return dbError(error)
      return json({ block: data })
    }

    if (method === 'PATCH') {
      const body = await readBody()
      if (typeof body.html !== 'string') return json({ error: 'html is required' }, 400)
      const { data, error } = await admin
        .from('cms_blocks')
        .update({ html: body.html, updated_at: nowIso() })
        .eq('client_id', clientId)
        .eq('page_slug', pageSlug)
        .eq('block_key', blockKey)
        .select()
        .maybeSingle()
      if (error) return dbError(error)
      if (!data) return json({ error: 'Not found' }, 404)
      return json({ block: data })
    }

    if (method === 'DELETE') {
      const { error } = await admin
        .from('cms_blocks')
        .delete()
        .eq('client_id', clientId)
        .eq('page_slug', pageSlug)
        .eq('block_key', blockKey)
      if (error) return dbError(error)
      return json({ ok: true })
    }
  }

  return json({ error: `Route not found: ${method} ${path}` }, 404)
}

// -----------------------------------------------------------------------------
// GATEWAY PATH — called by the internal dashboard with a user JWT
// -----------------------------------------------------------------------------
// >>> CUSTOMIZE: the roles allowed to edit content, matching your own
// user_roles table.
const ALLOWED_ROLES = new Set(['admin', 'team_leader', 'team_member'])
const RETRYABLE_STATUS = new Set([502, 503, 504])

async function getRoles(userId: string): Promise<string[]> {
  const cached = rolesCache.get(userId)
  if (cached) return cached
  const { data, error } = await admin.from('user_roles').select('role').eq('user_id', userId)
  if (error) throw error
  const roles = (data ?? []).map((r: { role: string }) => r.role)
  rolesCache.set(userId, roles)
  return roles
}

async function getClientRow(clientId: string) {
  const cached = clientRowCache.get(clientId)
  if (cached !== undefined) return cached
  const { data, error } = await admin
    .from('clients')
    .select('website_url, cms_api_key')
    .eq('id', clientId)
    .maybeSingle()
  if (error) throw error
  const row = (data as { website_url: string; cms_api_key: string } | null) ?? null
  clientRowCache.set(clientId, row)
  return row
}

/**
 * One retry, and only for methods that are safe to repeat — a POST/PATCH that
 * timed out may well have been applied upstream already.
 */
async function fetchUpstream(targetUrl: string, init: RequestInit, method: string) {
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE'
  let lastErr: unknown = null

  for (let attempt = 0; attempt < (idempotent ? 2 : 1); attempt++) {
    try {
      const res = await fetch(targetUrl, {
        ...init,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (attempt === 0 && idempotent && RETRYABLE_STATUS.has(res.status)) {
        // Drain so the connection can be reused for the retry.
        await res.body?.cancel()
        continue
      }
      return res
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('upstream fetch failed')
}

async function handleGateway(req: Request): Promise<Response> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: 'Unauthorized' }, 401)

  // The JWT check and the request body are independent — read them together
  // rather than serializing an auth round trip in front of a body parse.
  // getUser(token) on the admin client avoids constructing a second client
  // (and its anon-key env dependency) on every request.
  const [userRes, payload] = await Promise.all([
    admin.auth.getUser(token),
    req.json().catch(() => null) as Promise<
      { client_id?: string; method?: string; path?: string; body?: unknown } | null
    >,
  ])

  if (userRes.error || !userRes.data?.user) return json({ error: 'Unauthorized' }, 401)
  const userId = userRes.data.user.id

  if (!payload?.client_id || !payload.path) {
    return json({ error: 'client_id and path are required' }, 400)
  }
  const method = (payload.method || 'GET').toUpperCase()

  // Role check and client lookup are independent of each other.
  const [roles, client] = await Promise.all([getRoles(userId), getClientRow(payload.client_id)])

  if (!roles.some((r) => ALLOWED_ROLES.has(r))) return json({ error: 'Forbidden' }, 403)
  if (!client) return json({ error: 'Client not found' }, 404)

  const website = normalizeWebsiteUrl(client.website_url || '')
  const apiKey = (client.cms_api_key || '').trim()
  if (!website || !apiKey) {
    return json({ error: 'CMS not configured for this client yet', code: 'not_configured' }, 409)
  }

  const targetUrl = `${website}/api/cms${payload.path.startsWith('/') ? '' : '/'}${payload.path}`
  const sendsBody = payload.body !== undefined && method !== 'GET' && method !== 'HEAD'
  const init: RequestInit = {
    method,
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
      ...(sendsBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(sendsBody
      ? {
          body:
            typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
        }
      : {}),
  }

  let upstream: Response
  try {
    upstream = await fetchUpstream(targetUrl, init, method)
  } catch (e) {
    const err = e as Error
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    return json(
      {
        error: timedOut
          ? `CMS at ${website} did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`
          : `Could not reach CMS at ${website}: ${err.message}`,
        code: timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      },
      timedOut ? 504 : 502,
    )
  }

  const text = await upstream.text()

  if (upstream.ok) {
    // Body is already JSON on the wire — hand it straight back instead of
    // parsing and re-stringifying what can be a large HTML-bearing payload.
    if (!text) return json({}, upstream.status)
    const first = text.trimStart()[0]
    if (first === '{' || first === '[') return rawJson(text, upstream.status)
    return json(text, upstream.status)
  }

  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* keep as text */
  }
  const errMsg =
    (data && typeof data === 'object' && (data as { error?: string }).error) ||
    (typeof data === 'string' && data) ||
    `CMS request failed (${upstream.status})`
  return json({ error: errMsg, status: upstream.status, body: data }, upstream.status)
}

// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })

  try {
    const apiKey = (req.headers.get('x-api-key') || '').trim()
    return apiKey ? await handleStorage(req, apiKey) : await handleGateway(req)
  } catch (e) {
    const err = e as Error & { code?: string }
    console.error('cms-api unhandled error', err?.message, err?.stack)
    return json({ error: err?.message ?? 'Internal error', code: err?.code }, 500)
  }
})
