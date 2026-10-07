begin;
create table public.order_fulfillments (
  order_id uuid primary key references public.orders(id),
  state text not null default 'preparing' check(state in ('preparing','dispatched','submitted')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  shop_id text,
  printify_order_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.order_fulfillments enable row level security;
revoke all on public.order_fulfillments from public, anon, authenticated;
grant all on public.order_fulfillments to service_role;
create or replace function public.claim_order_fulfillment(p_order_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; f public.order_fulfillments;
begin
 select * into o from public.orders where id=p_order_id for update;
 if not found or o.stripe_session_id is null then raise exception 'Verified paid order required'; end if;
 if o.printify_order_id is not null then return jsonb_build_object('action','submitted','printify_order_id',o.printify_order_id); end if;
 if o.status <> 'paid' then raise exception 'Order is not eligible for fulfillment'; end if;
 select * into f from public.order_fulfillments where order_id=p_order_id;
 if found then
  if f.state='dispatched' then return to_jsonb(f)||jsonb_build_object('action','reconcile'); end if;
  if f.state='submitted' then return to_jsonb(f)||jsonb_build_object('action','submitted'); end if;
  if f.lease_until>now() then return jsonb_build_object('action','busy'); end if;
 end if;
 insert into public.order_fulfillments(order_id,claim_token,lease_until)
 values(p_order_id,p_token,now()+interval '5 minutes')
 on conflict(order_id) do update set claim_token=p_token,lease_until=now()+interval '5 minutes',updated_at=now();
 return jsonb_build_object('action','prepare');
end $$;
create or replace function public.complete_order_fulfillment(p_order_id uuid,p_shop_id text,p_printify_id text)
returns void language plpgsql security definer set search_path='' as $$
declare f public.order_fulfillments;
begin
 select * into f from public.order_fulfillments where order_id=p_order_id for update;
 if not found or f.state not in ('dispatched','submitted') or f.shop_id is distinct from p_shop_id
 or nullif(p_printify_id,'') is null or (f.printify_order_id is not null and f.printify_order_id<>p_printify_id)
 then raise exception 'Fulfillment mismatch'; end if;
 update public.order_fulfillments set state='submitted',printify_order_id=p_printify_id,last_error=null,updated_at=now() where order_id=p_order_id;
 update public.orders set printify_order_id=p_printify_id,status=case when status='paid' then 'submitted' else status end,updated_at=now() where id=p_order_id;
end $$;
revoke all on function public.claim_order_fulfillment(uuid,uuid) from public,anon,authenticated;
revoke all on function public.complete_order_fulfillment(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_order_fulfillment(uuid,uuid) to service_role;
grant execute on function public.complete_order_fulfillment(uuid,text,text) to service_role;
commit;
