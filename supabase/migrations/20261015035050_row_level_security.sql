-- ACCESS HELPERS (security definer so policies don't recurse) --------
create or replace function public.is_guide_member(p_guide uuid, p_roles text[] default array['owner','editor','viewer'])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.guide_members m
    where m.guide_id = p_guide and m.user_id = auth.uid() and m.role = any(p_roles)
  );
$$;

create or replace function public.can_view_disco(p_disco uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.discos d where d.id = p_disco and d.user_id = auth.uid())
      or exists (select 1 from public.shares s where s.disco_id = p_disco and s.to_user_id = auth.uid())
      or exists (select 1 from public.disco_saves v where v.disco_id = p_disco and v.user_id = auth.uid())
      or exists (
        select 1 from public.guide_items gi
        join public.guide_members gm on gm.guide_id = gi.guide_id
        where gi.disco_id = p_disco and gm.user_id = auth.uid()
      );
$$;

create or replace function public.can_view_target(p_type text, p_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'disco' then public.can_view_disco(p_id)
    when 'guide' then public.is_guide_member(p_id)
    when 'guide_item' then exists (
      select 1 from public.guide_items gi where gi.id = p_id and public.is_guide_member(gi.guide_id)
    )
    else false
  end;
$$;

create or replace function public.is_connected(p_other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.connections c
    where c.status = 'accepted'
      and ((c.requester_id = auth.uid() and c.addressee_id = p_other)
        or (c.addressee_id = auth.uid() and c.requester_id = p_other))
  );
$$;

create or replace function public.can_see_profile(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_profile = auth.uid()
      or public.is_connected(p_profile)
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

-- ENABLE RLS EVERYWHERE ---------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','user_settings','topics','topic_aliases','topic_art','user_topics','dig_submissions',
    'sources','user_source_prefs','articles','article_topics',
    'discos','disco_topics','disco_media','revisions','vocab_progress',
    'editions','edition_items','edition_item_discos','votes','saved_articles','feed_events',
    'guides','guide_members','guide_items','connections','shares','share_links','disco_saves','comments','notifications'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- SHARED CATALOG: readable by signed-in users; written by the service role
create policy "catalog read" on public.topics for select to authenticated using (true);
create policy "users add topics" on public.topics for insert to authenticated with check (created_by = (select auth.uid()));
create policy "catalog read" on public.topic_aliases for select to authenticated using (true);
create policy "users add aliases" on public.topic_aliases for insert to authenticated with check (true);
create policy "catalog read" on public.topic_art for select to authenticated using (true);
create policy "catalog read" on public.sources for select to authenticated using (true);
create policy "catalog read" on public.articles for select to authenticated using (true);
create policy "catalog read" on public.article_topics for select to authenticated using (true);

-- PROFILES
create policy "see self and people you share with" on public.profiles for select to authenticated using (public.can_see_profile(id));
create policy "edit own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- OWN-ROW TABLES (full control of your own rows)
do $$
declare t text;
begin
  foreach t in array array[
    'user_settings','user_topics','dig_submissions','user_source_prefs','disco_topics',
    'vocab_progress','votes','saved_articles'
  ] loop
    execute format($f$create policy "own rows" on public.%I for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))$f$, t);
  end loop;
end $$;

-- Append-only logs: read and add your own
create policy "read own" on public.revisions for select to authenticated using (user_id = (select auth.uid()));
create policy "add own" on public.revisions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "read own" on public.feed_events for select to authenticated using (user_id = (select auth.uid()));
create policy "add own" on public.feed_events for insert to authenticated with check (user_id = (select auth.uid()));

-- Feed output: written by the feed engine, read by its owner
create policy "read own" on public.editions for select to authenticated using (user_id = (select auth.uid()));
create policy "read own" on public.edition_items for select to authenticated using (user_id = (select auth.uid()));
create policy "read own" on public.edition_item_discos for select to authenticated using (user_id = (select auth.uid()));

-- Notifications: created by the system, managed by their owner
create policy "read own" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "mark read" on public.notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "dismiss" on public.notifications for delete to authenticated using (user_id = (select auth.uid()));

-- DISCOS: owner writes; owner + the four sharing paths can read
create policy "read own or shared" on public.discos for select to authenticated using (user_id = (select auth.uid()) or public.can_view_disco(id));
create policy "add own" on public.discos for insert to authenticated with check (user_id = (select auth.uid()));
create policy "edit own" on public.discos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own" on public.discos for delete to authenticated using (user_id = (select auth.uid()));

create policy "read own or shared" on public.disco_media for select to authenticated using (user_id = (select auth.uid()) or public.can_view_disco(disco_id));
create policy "add own" on public.disco_media for insert to authenticated with check (user_id = (select auth.uid()));
create policy "edit own" on public.disco_media for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own" on public.disco_media for delete to authenticated using (user_id = (select auth.uid()));

-- Saving a disco someone shared with you (linked copy)
create policy "read own" on public.disco_saves for select to authenticated using (user_id = (select auth.uid()));
create policy "save shared" on public.disco_saves for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.shares s where s.disco_id = disco_saves.disco_id and s.to_user_id = (select auth.uid()))
);
create policy "unsave" on public.disco_saves for delete to authenticated using (user_id = (select auth.uid()));

-- GUIDES
create policy "members read" on public.guides for select to authenticated using (owner_id = (select auth.uid()) or public.is_guide_member(id));
create policy "create own" on public.guides for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner or editor edits" on public.guides for update to authenticated using (public.is_guide_member(id, array['owner','editor']));
create policy "owner deletes" on public.guides for delete to authenticated using (owner_id = (select auth.uid()));

create policy "members read" on public.guide_members for select to authenticated using (public.is_guide_member(guide_id));
create policy "owner invites" on public.guide_members for insert to authenticated with check (public.is_guide_member(guide_id, array['owner']) and invited_by = (select auth.uid()));
create policy "owner changes roles" on public.guide_members for update to authenticated using (public.is_guide_member(guide_id, array['owner']));
create policy "owner removes or member leaves" on public.guide_members for delete to authenticated using (public.is_guide_member(guide_id, array['owner']) or user_id = (select auth.uid()));

create policy "members read" on public.guide_items for select to authenticated using (public.is_guide_member(guide_id));
create policy "editors add" on public.guide_items for insert to authenticated with check (
  public.is_guide_member(guide_id, array['owner','editor'])
  and added_by = (select auth.uid())
  and (disco_id is null or exists (select 1 from public.discos d where d.id = guide_items.disco_id and d.user_id = (select auth.uid())))
);
create policy "editors edit" on public.guide_items for update to authenticated using (public.is_guide_member(guide_id, array['owner','editor']));
create policy "editors remove" on public.guide_items for delete to authenticated using (public.is_guide_member(guide_id, array['owner','editor']));

-- CONNECTIONS
create policy "either side reads" on public.connections for select to authenticated using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));
create policy "request" on public.connections for insert to authenticated with check (requester_id = (select auth.uid()) and status = 'pending');
create policy "either side updates" on public.connections for update to authenticated using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));
create policy "either side removes" on public.connections for delete to authenticated using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

-- SHARES (between connected Disco users)
create policy "sender or recipient reads" on public.shares for select to authenticated using (from_user_id = (select auth.uid()) or to_user_id = (select auth.uid()));
create policy "share with a connection" on public.shares for insert to authenticated with check (
  from_user_id = (select auth.uid())
  and public.is_connected(to_user_id)
  and (disco_id is null or exists (select 1 from public.discos d where d.id = shares.disco_id and d.user_id = (select auth.uid())))
  and (guide_id is null or public.is_guide_member(guide_id, array['owner']))
);
create policy "sender unshares" on public.shares for delete to authenticated using (from_user_id = (select auth.uid()));

-- SHARE LINKS (public pages are served by a server function, not by these policies)
create policy "own links" on public.share_links for select to authenticated using (created_by = (select auth.uid()));
create policy "link own discos" on public.share_links for insert to authenticated with check (
  created_by = (select auth.uid())
  and exists (select 1 from public.discos d where d.id = share_links.disco_id and d.user_id = (select auth.uid()))
);
create policy "revoke own" on public.share_links for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "delete own" on public.share_links for delete to authenticated using (created_by = (select auth.uid()));

-- COMMENTS
create policy "read where you have access" on public.comments for select to authenticated using (public.can_view_target(target_type, target_id));
create policy "comment where you have access" on public.comments for insert to authenticated with check (user_id = (select auth.uid()) and public.can_view_target(target_type, target_id));
create policy "edit own" on public.comments for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own" on public.comments for delete to authenticated using (user_id = (select auth.uid()));
