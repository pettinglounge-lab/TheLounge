-- Apply before deploying the updated finalize-order function.
begin;
alter table public.orders alter column portrait_id drop not null;
alter table public.orders
  add column draft_id uuid references public.order_drafts(id),
  add column stripe_session_id text,
  add column artwork_path text,
  add column product_snapshot jsonb,
  add column quantity integer check (quantity between 1 and 5);
create unique index orders_draft_id_unique on public.orders(draft_id);
create unique index orders_stripe_session_id_unique on public.orders(stripe_session_id);

-- Only verified server-side payments may call this function. The draft lock
-- serializes concurrent deliveries; both unique indexes also enforce identity.
create or replace function public.finalize_paid_order(
  p_draft_id uuid, p_user_id uuid, p_session_id text,
  p_subtotal integer, p_total integer, p_currency text,
  p_email text, p_ship_name text, p_ship_address jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.order_drafts;
  o public.orders;
begin
  select * into d from public.order_drafts where id = p_draft_id for update;
  if not found then raise exception 'Draft missing'; end if;
  if p_user_id is distinct from d.user_id
    or p_subtotal is distinct from d.subtotal_cents
    or p_currency is distinct from d.currency
    or p_total is null or p_total < p_subtotal
    or p_session_id is null or p_session_id not like 'cs_live_%'
    or nullif(btrim(p_email), '') is null
    or nullif(btrim(p_ship_name), '') is null
    or nullif(p_ship_address->>'line1', '') is null
    or nullif(p_ship_address->>'country', '') is null then
    raise exception 'Payment does not match draft';
  end if;
  select * into o from public.orders where draft_id = d.id;
  if found then
    if o.stripe_session_id is distinct from p_session_id then
      raise exception 'Draft already paid through another session; review payment';
    end if;
    return jsonb_build_object('orderId', o.id, 'status', o.status, 'replayed', true);
  end if;
  insert into public.orders(user_id, draft_id, stripe_session_id, email,
    ship_name, ship_address, amount_total, currency, printify_product_id,
    status, artwork_path, product_snapshot, quantity)
  values(d.user_id, d.id, p_session_id, p_email, p_ship_name, p_ship_address,
    p_total, d.currency, d.product_snapshot->>'printify_product_id',
    'paid', d.artwork_path, d.product_snapshot, d.quantity)
  returning * into o;
  return jsonb_build_object('orderId', o.id, 'status', o.status, 'replayed', false);
end;
$$;
revoke all on function public.finalize_paid_order(uuid,uuid,text,integer,integer,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_paid_order(uuid,uuid,text,integer,integer,text,text,text,jsonb)
  to service_role;
commit;
