-- Short names can mean more than one topic ("Freud" = Sigmund or Lucian). An alias may now point
-- to several topics, and capture picks among them by the person's own habits and by the other
-- tags on the same disco. (Reading the disco's text itself is added with embeddings later.)

drop index if exists public.topic_aliases_alias_uidx;
create unique index topic_aliases_topic_alias_uidx on public.topic_aliases(topic_id, lower(alias));
create index topic_aliases_alias_lower_idx on public.topic_aliases(lower(alias));

-- A topic, the topics it is linked to (either direction), and their parents up to three levels.
create or replace function private.topic_neighborhood(p uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  with recursive seeds as (
    select p as id
    union select l.related_id from public.topic_links l where l.topic_id = p
    union select l.topic_id from public.topic_links l where l.related_id = p
  ), up(id, depth) as (
    select id, 0 from seeds
    union all
    select t.parent_id, up.depth + 1 from up join public.topics t on t.id = up.id
     where t.parent_id is not null and up.depth < 3
  )
  select coalesce(array_agg(distinct id), '{}') from up;
$$;

-- A short description to tell same-named topics apart: "psychoanalysis", "painting".
create or replace function private.topic_hint(p uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.label from public.topic_links l join public.topics r on r.id = l.related_id
      where l.topic_id = p and l.relation in ('about','by') order by l.created_at limit 1),
    (select pt.label from public.topics t join public.topics pt on pt.id = t.parent_id where t.id = p));
$$;

drop function if exists private.resolve_topic(text, uuid);

-- Resolve a typed tag to a topic. Candidates: topics whose name or slug matches, plus topics that
-- have it as an alias. Score: exact name (+1), how often this person used it (+2·ln(1+n)), and how
-- many of the disco's other tags sit near it (+3 each). Unknown tags become new topics.
create or replace function private.resolve_topic(
  p_label text, p_uid uuid, p_context uuid[] default '{}',
  out topic_id uuid, out label text, out created boolean, out alternatives jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_slug text := private.slugify(p_label);
  v_all jsonb;
begin
  created := false; alternatives := '[]'::jsonb;
  with raw as (
    select t.id, (lower(t.label) = lower(trim(p_label)) or t.slug = v_slug) as exact
      from public.topics t where lower(t.label) = lower(trim(p_label)) or t.slug = v_slug
    union all
    select a.topic_id, false from public.topic_aliases a where lower(a.alias) = lower(trim(p_label))
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
  select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'hint', private.topic_hint(id))
                   order by score desc, level desc nulls first, slug)
    into v_all from scored;

  if v_all is not null then
    topic_id := (v_all->0->>'id')::uuid;
    label := v_all->0->>'label';
    alternatives := v_all - 0;
    return;
  end if;

  if v_slug = '' then v_slug := 'topic-' || substr(md5(p_label), 1, 8); end if;
  insert into public.topics (slug, label, created_by) values (v_slug, trim(p_label), p_uid)
    on conflict (slug) do nothing
    returning id, topics.label into topic_id, label;
  if topic_id is null then
    select t.id, t.label into topic_id, label from public.topics t where t.slug = v_slug;
  else
    created := true;
  end if;
end;
$$;
revoke all on function private.resolve_topic(text, uuid, uuid[]) from public, anon, authenticated;
revoke all on function private.topic_neighborhood(uuid) from public, anon;
revoke all on function private.topic_hint(uuid) from public, anon;
grant execute on function private.topic_hint(uuid) to authenticated;

-- Capture: same as before, except tags resolve in two passes so an ambiguous short name is
-- decided by the disco's other tags, and the reply lists the alternatives so the app can offer
-- a one-tap correction.
create or replace function public.capture_disco(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_quote text := nullif(trim(p->>'quote'), '');
  v_text text := nullif(trim(p->>'text_captured'), '');
  v_word text;
  v_kind text := nullif(p->>'kind', '');
  v_details jsonb := coalesce(p->'details', '{}'::jsonb);
  v_source uuid;
  v_disco uuid;
  v_tag text;
  v_res jsonb := '[]'::jsonb;
  v_ctx uuid[];
  v_topics jsonb := '[]'::jsonb;
  i int;
  r record;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if jsonb_typeof(v_details) <> 'object' then v_details := '{}'::jsonb; end if;

  if nullif(p->>'client_id','') is not null then
    select id into v_existing from public.discos where user_id = v_uid and client_id = p->>'client_id';
    if v_existing is not null then
      return jsonb_build_object('id', v_existing, 'duplicate', true);
    end if;
  end if;

  if coalesce(v_quote, v_text) is null and p->'image' is null and v_kind is distinct from 'video' then
    raise exception 'nothing to save: send quote, text_captured, image or a video moment' using errcode = '22023';
  end if;
  if length(coalesce(v_quote,'')) > 20000 or length(coalesce(v_text,'')) > 50000 then
    raise exception 'capture too long' using errcode = '22001';
  end if;

  if v_kind is null then
    v_word := coalesce(v_quote, v_text);
    v_kind := case
      when p->'image' is not null then 'image'
      when v_word ~ '^[[:alpha:]][[:alpha:]''’-]{0,39}$' then 'vocabulary'
      else 'highlight' end;
  end if;
  if v_kind not in ('highlight','vocabulary','image','video','note') then v_kind := 'highlight'; end if;
  if v_kind = 'vocabulary' then
    v_word := coalesce(v_quote, v_text);
    v_details := jsonb_build_object('word', v_word, 'example',
                   nullif(trim(concat_ws(' ', p->>'prefix', v_word, p->>'suffix')), '')) || v_details;
  end if;

  if p->'source' is not null and jsonb_typeof(p->'source') = 'object' then
    v_source := private.resolve_source(p->'source', v_uid);
  end if;

  insert into public.discos (user_id, kind, quote, text_captured, prefix, suffix, note, details, url,
                             source_id, captured_at, capture_method, client_id)
  values (v_uid, v_kind, v_quote, v_text, nullif(p->>'prefix',''), nullif(p->>'suffix',''),
          nullif(trim(p->>'note'),''), v_details, nullif(p->>'url',''), v_source,
          coalesce((p->>'captured_at')::timestamptz, now()),
          case when p->>'capture_method' in ('extension','shortcut','share','paste','feed','kindle')
               then p->>'capture_method' else 'extension' end,
          nullif(p->>'client_id',''))
  returning id into v_disco;

  if jsonb_typeof(p->'tags') = 'array' then
    -- Pass 1: resolve every tag on its own
    for v_tag in select distinct trim(x) from jsonb_array_elements_text(p->'tags') x where trim(x) <> '' limit 25 loop
      select * into r from private.resolve_topic(v_tag, v_uid, '{}');
      v_res := v_res || jsonb_build_array(jsonb_build_object(
        'tag', v_tag, 'id', r.topic_id, 'label', r.label, 'created', r.created, 'alternatives', r.alternatives));
    end loop;
    -- Pass 2: re-decide ambiguous names using the disco's other tags
    for i in 0 .. jsonb_array_length(v_res) - 1 loop
      if jsonb_array_length(v_res->i->'alternatives') > 0 then
        select array_agg((e.v->>'id')::uuid) into v_ctx
          from jsonb_array_elements(v_res) with ordinality e(v, n) where e.n - 1 <> i;
        select * into r from private.resolve_topic(v_res->i->>'tag', v_uid, coalesce(v_ctx, '{}'));
        v_res := jsonb_set(v_res, array[i::text], jsonb_build_object(
          'tag', v_res->i->>'tag', 'id', r.topic_id, 'label', r.label, 'created', false, 'alternatives', r.alternatives));
      end if;
    end loop;
    insert into public.disco_topics (user_id, disco_id, topic_id)
      select v_uid, v_disco, (e->>'id')::uuid from jsonb_array_elements(v_res) e
      on conflict do nothing;
    select coalesce(jsonb_agg(e - 'tag'), '[]'::jsonb) into v_topics from jsonb_array_elements(v_res) e;
  end if;

  if v_kind = 'image' and jsonb_typeof(p->'image') = 'object' then
    if coalesce(p->'image'->>'storage_path','') not like v_uid::text || '/%' then
      raise exception 'image must be uploaded to your own folder first' using errcode = '42501';
    end if;
    insert into public.disco_media (user_id, disco_id, storage_path, original_url, alt_text, caption, width, height)
    values (v_uid, v_disco, p->'image'->>'storage_path', p->'image'->>'original_url',
            p->'image'->>'alt_text', p->'image'->>'caption',
            (p->'image'->>'width')::int, (p->'image'->>'height')::int);
  end if;

  return jsonb_build_object('id', v_disco, 'kind', v_kind, 'source_id', v_source, 'topics', v_topics, 'duplicate', false);
end;
$$;
revoke all on function public.capture_disco(jsonb) from public, anon;
grant execute on function public.capture_disco(jsonb) to authenticated;

-- Tag suggestions now include a hint, so same-named topics can be told apart while typing.
drop function if exists public.suggest_tags(text, int);
create function public.suggest_tags(q text, max_results int default 8)
returns table (topic_id uuid, label text, hint text, similarity real, times_used bigint)
language sql stable security invoker set search_path = '' as $$
  with cand as (
    select t.id, t.label, extensions.similarity(lower(t.label), lower(q)) as sim from public.topics t
     where lower(t.label) operator(extensions.%) lower(q) or t.label ilike q || '%'
    union all
    select t.id, t.label, extensions.similarity(lower(a.alias), lower(q)) from public.topic_aliases a
      join public.topics t on t.id = a.topic_id
     where lower(a.alias) operator(extensions.%) lower(q) or a.alias ilike q || '%'
  )
  select c.id, c.label, private.topic_hint(c.id), max(c.sim)::real,
         (select count(*) from public.disco_topics dt where dt.topic_id = c.id and dt.user_id = auth.uid())
  from cand c group by c.id, c.label
  order by 5 desc, 4 desc limit greatest(1, least(max_results, 25));
$$;
revoke all on function public.suggest_tags(text, int) from public, anon;
grant execute on function public.suggest_tags(text, int) to authenticated;
