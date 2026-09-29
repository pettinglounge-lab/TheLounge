-- Run once in Supabase SQL Editor before deploying save-order-draft.
create table public.order_drafts (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  request_hash text not null,
  status text not null default 'draft' check (status = 'draft'),
  category text not null check (category in ('pet', 'home', 'memory')),
  product_snapshot jsonb not null,
  quantity integer not null check (quantity between 1 and 5),
  unit_price_cents integer not null check (unit_price_cents > 0),
  subtotal_cents integer generated always as (quantity * unit_price_cents) stored,
  currency text not null default 'usd' check (currency = 'usd'),
  artwork_path text not null,
  created_at timestamptz not null default now()
);
alter table public.order_drafts enable row level security;
revoke all on public.order_drafts from anon, authenticated;
grant select on public.order_drafts to authenticated;
grant all on public.order_drafts to service_role;
create policy "Customers read own order drafts" on public.order_drafts
  for select to authenticated using (auth.uid() = user_id);

-- Private originals for fulfillment; only the server can upload or retrieve them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-artwork', 'order-artwork', false, 20971520,
  array['image/png', 'image/jpeg', 'image/webp']);
