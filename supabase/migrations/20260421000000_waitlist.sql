-- Public waitlist: captures emails from the landing page.
-- Anonymous (unauthenticated) users insert via the service role from /api/waitlist.
-- Nothing is ever exposed back to the browser, so RLS stays restrictive — only
-- the service role touches this table.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  note text,
  source text,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Case-insensitive dedup on email.
create unique index if not exists waitlist_email_lower_uniq
  on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

-- No RLS policies on purpose: only the service-role client (which bypasses RLS)
-- can read or write. anon/authenticated clients see nothing.

comment on table public.waitlist is
  'Landing-page waitlist signups. Inserted via /api/waitlist using the service role.';
