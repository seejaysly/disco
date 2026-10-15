-- Tags people create are private to them until they're clearly public knowledge, and a tag for
-- someone in a person's own life ("Anu") is personal: never shared, never a feed topic, never a theme.
--   owner_id null  = shared catalog (DIG, well-known people, works, places, subjects)
--   owner_id set   = visible only to that user (new tags start here; a server job promotes them)
--   personal true  = also never promoted, never used to choose feed topics or infer themes
alter table public.topics add column owner_id uuid references public.profiles(id) on delete cascade;
alter table public.topics add column personal boolean not null default false;
alter table public.topics add constraint topics_personal_is_owned check (not personal or owner_id is not null);
create index topics_owner_idx on public.topics(owner_id) where owner_id is not null;
comment on column public.topics.owner_id is 'Null: shared catalog. Set: a tag only this user sees, until promoted to shared by a server job.';
comment on column public.topics.personal is 'Someone or something from this user''s own life. Never shared, never a feed topic, never a theme.';

create or replace function private.can_see_topic(p uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.topics t where t.id = p and (t.owner_id is null or t.owner_id = (select auth.uid())));
$$;
revoke all on function private.can_see_topic(uuid) from public, anon;
grant execute on function private.can_see_topic(uuid) to authenticated;

alter policy "catalog read" on public.topics using (owner_id is null or owner_id = (select auth.uid()));
alter policy "users add topics" on public.topics
  with check (created_by = (select auth.uid()) and owner_id = (select auth.uid()));
create policy "owners edit own topics" on public.topics for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
alter policy "catalog read" on public.topic_aliases using (private.can_see_topic(topic_id));
alter policy "users add aliases" on public.topic_aliases
  with check (exists (select 1 from public.topics t where t.id = topic_id and t.owner_id = (select auth.uid())));
alter policy "catalog read" on public.topic_links using (private.can_see_topic(topic_id) and private.can_see_topic(related_id));

-- Tag matching only sees shared topics and the person's own; a new tag is created private to them.
create or replace function private.resolve_topic(
  p_label text, p_uid uuid, p_context uuid[],
  out topic_id uuid, out label text, out created boolean, out alternatives jsonb)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_slug text := private.slugify(p_label);
  v_all jsonb;
begin
  created := false; alternatives := '[]'::jsonb;
  with raw as (
    select t.id, (lower(t.label) = lower(trim(p_label)) or t.slug = v_slug) as exact
      from public.topics t
     where (lower(t.label) = lower(trim(p_label)) or t.slug = v_slug)
       and (t.owner_id is null or t.owner_id = p_uid)
    union all
    select a.topic_id, false from public.topic_aliases a join public.topics t on t.id = a.topic_id
     where lower(a.alias) = lower(trim(p_label)) and (t.owner_id is null or t.owner_id = p_uid)
  ), cands as (
    select r.id, bool_or(r.exact) as exact, t.label, t.level, t.slug
      from raw r join public.topics t on t.id = r.id group by r.id, t.label, t.level, t.slug
  ), scored as (
    select c.*,
      (case when c.exact then 1 else 0 end)
      + 2 * ln(1 + (select count(*) from public.disco_topics dt where dt.topic_id = c.id and dt.user_id = p_uid))
      + 3 * (select count(*) from unnest(p_context) ctx
              where ctx <> c.id and private.topic_neighborhood(ctx) && private.topic_neighborhood(c.id)) as score
      from cands c
  )
  select jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'hint', private.topic_hint(s.id))
                   order by s.score desc, s.level desc nulls first, s.slug)
    into v_all from scored s;

  if v_all is not null then
    topic_id := (v_all->0->>'id')::uuid;
    label := v_all->0->>'label';
    alternatives := v_all - 0;
    return;
  end if;

  if v_slug = '' then v_slug := 'topic-' || substr(md5(p_label), 1, 8); end if;
  -- private tags get a per-user slug so two people's "recipes" never collide
  v_slug := v_slug || '-' || substr(md5(p_uid::text), 1, 8);
  insert into public.topics (slug, label, created_by, owner_id) values (v_slug, trim(p_label), p_uid, p_uid)
    on conflict (slug) do nothing
    returning id, topics.label into topic_id, label;
  if topic_id is null then
    select t.id, t.label into topic_id, label from public.topics t where t.slug = v_slug and t.owner_id = p_uid;
  else
    created := true;
  end if;
end;
$$;
revoke all on function private.resolve_topic(text, uuid, uuid[]) from public, anon, authenticated;

-- One tap in the app: mark one of your own tags as personal (or not).
create or replace function public.set_topic_personal(p_topic uuid, p_personal boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.topics set personal = p_personal
   where id = p_topic and owner_id = (select auth.uid());
  if not found then raise exception 'you can only mark your own tags' using errcode = '42501'; end if;
end;
$$;
revoke all on function public.set_topic_personal(uuid, boolean) from public, anon;
grant execute on function public.set_topic_personal(uuid, boolean) to authenticated;

-- Coda import: personal tags are created owned by the importing user, before the main apply step.
create or replace function private.coda_import_personal(p_batch text, p_email text)
returns int language plpgsql security definer set search_path = '' as $$
declare v_uid uuid; v_n int;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then raise exception 'no user with email %', p_email; end if;
  insert into public.topics (slug, label, kind, created_by, owner_id, personal)
  select e.value->>'slug', e.value->>'label', coalesce(e.value->>'kind', 'person'), v_uid, v_uid, true
    from private.coda_staging s, jsonb_array_elements(s.payload) e
   where s.batch = p_batch and s.kind = 'personal_topics'
  on conflict (slug) do update set label = excluded.label, personal = true
   where public.topics.owner_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function private.coda_import_personal(text, text) from public, anon, authenticated;
