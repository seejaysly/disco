-- Move access helpers out of the public API into a private schema (policies keep working)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

alter function public.is_guide_member(uuid, text[]) set schema private;
alter function public.can_view_disco(uuid) set schema private;
alter function public.can_view_target(text, uuid) set schema private;
alter function public.is_connected(uuid) set schema private;
alter function public.can_see_profile(uuid) set schema private;

-- can_view_target and can_see_profile call sibling helpers by name; repoint them
create or replace function private.can_view_target(p_type text, p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'disco' then private.can_view_disco(p_id)
    when 'guide' then private.is_guide_member(p_id)
    when 'guide_item' then exists (
      select 1 from public.guide_items gi where gi.id = p_id and private.is_guide_member(gi.guide_id)
    )
    else false
  end;
$$;

create or replace function private.can_see_profile(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_profile = auth.uid()
      or private.is_connected(p_profile)
      or exists (
        select 1 from public.guide_members a
        join public.guide_members b on b.guide_id = a.guide_id
        where a.user_id = auth.uid() and b.user_id = p_profile
      )
      or exists (
        select 1 from public.connections c
        where c.status = 'pending'
          and ((c.requester_id = auth.uid() and c.addressee_id = p_profile)
            or (c.addressee_id = auth.uid() and c.requester_id = p_profile))
      );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;

-- Trigger-only functions: nobody calls these directly
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.add_guide_owner() from public, anon, authenticated;

create index if not exists topics_created_by_idx on public.topics(created_by);
