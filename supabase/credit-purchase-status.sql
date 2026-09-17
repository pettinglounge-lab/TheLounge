-- Read-only confirmation for the signed-in purchaser. Does not grant credits.
begin;
create or replace function public.get_credit_purchase_status(p_session_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('fulfilled', true, 'credits', credits, 'livemode', livemode)
    from public.credit_purchases
    where stripe_session_id = p_session_id and user_id = (select auth.uid())
  ), jsonb_build_object('fulfilled', false));
$$;
revoke all on function public.get_credit_purchase_status(text) from public, anon;
grant execute on function public.get_credit_purchase_status(text) to authenticated;
commit;
