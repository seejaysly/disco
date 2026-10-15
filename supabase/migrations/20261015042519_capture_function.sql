-- Idempotency key from capture tools (offline queue retries won't duplicate)
alter table public.discos add column client_id text;
create unique index discos_user_client_uidx on public.discos(user_id, client_id) where client_id is not null;

create or replace function private.slugify(t text)
returns text language sql immutable set search_path = '' as $$
  select trim(both '-' from regexp_replace(lower(trim(t)), '[^a-z0-9]+', '-', 'g'));
$$;

-- Resolve a tag string to a topic: exact label, slug, or alias (case-insensitive); else create it
create or replace function private.resolve_topic(p_label text, p_uid uuid, out topic_id uuid, out label text, out created boolean)
language plpgsql security definer set search_path = '' as $$
declare v_slug text := private.slugify(p_label);
begin
  created := false;
  select t.id, t.label into topic_id, label from public.topics t
   where lower(t.label) = lower(trim(p_label)) or t.slug = v_slug limit 1;
  if topic_id is null then
    select t.id, t.label into topic_id, label from public.topic_aliases a
      join public.topics t on t.id = a.topic_id
     where lower(a.alias) = lower(trim(p_label)) limit 1;
  end if;
  if topic_id is null then
    if v_slug = '' then v_slug := 'topic-' || substr(md5(p_label), 1, 8); end if;
    insert into public.topics (slug, label, created_by) values (v_slug, trim(p_label), p_uid)
      returning id, topics.label into topic_id, label;
    created := true;
  end if;
end;
$$;

create or replace function private.resolve_source(s jsonb, p_uid uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := coalesce(nullif(s->>'kind',''), 'outlet');
  v_name text := nullif(trim(s->>'name'), '');
  v_domain text := lower(nullif(trim(s->>'domain'), ''));
  v_author text := nullif(trim(s->>'author'), '');
  v_ext text := nullif(trim(s->>'external_id'), '');
  v_id uuid;
begin
  if v_kind not in ('outlet','book','video_channel','podcast','other') then v_kind := 'other'; end if;
  if v_ext is not null then
    select id into v_id from public.sources where kind = v_kind and external_id = v_ext limit 1;
  end if;
  if v_id is null and v_kind = 'outlet' and v_domain is not null then
    select id into v_id from public.sources where kind = 'outlet' and lower(domain) = v_domain limit 1;
  end if;
  if v_id is null and v_name is not null and v_kind <> 'outlet' then
    select id into v_id from public.sources
     where kind = v_kind and lower(name) = lower(v_name)
       and coalesce(lower(author),'') = coalesce(lower(v_author),'') limit 1;
  end if;
  if v_id is null and (v_name is not null or v_domain is not null) then
    insert into public.sources (kind, name, author, domain, homepage_url, external_id)
    values (v_kind, coalesce(v_name, v_domain), v_author, v_domain,
            case when v_domain is not null then 'https://' || v_domain end, v_ext)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- The one capture path for extension, Shortcut, paste box and Kindle import
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
  v_topics jsonb := '[]'::jsonb;
  r record;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if jsonb_typeof(v_details) <> 'object' then v_details := '{}'::jsonb; end if;

  -- Retried capture: return the original
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

  -- Kind: explicit, else image, else single word -> vocabulary, else highlight
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

  -- Tags
  if jsonb_typeof(p->'tags') = 'array' then
    for v_tag in select distinct trim(x) from jsonb_array_elements_text(p->'tags') x where trim(x) <> '' limit 25 loop
      select * into r from private.resolve_topic(v_tag, v_uid);
      insert into public.disco_topics (user_id, disco_id, topic_id) values (v_uid, v_disco, r.topic_id)
        on conflict do nothing;
      v_topics := v_topics || jsonb_build_object('id', r.topic_id, 'label', r.label, 'created', r.created);
    end loop;
  end if;

  -- Image already uploaded by the client into its own folder
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
revoke all on function private.resolve_topic(text, uuid) from public, anon, authenticated;
revoke all on function private.resolve_source(jsonb, uuid) from public, anon, authenticated;

-- Tag suggestions: "Did you mean…?" ranked by similarity, then by how often this user used it
create or replace function public.suggest_tags(q text, max_results int default 8)
returns table (topic_id uuid, label text, similarity real, times_used bigint)
language sql stable security invoker set search_path = '' as $$
  with cand as (
    select t.id, t.label, extensions.similarity(lower(t.label), lower(q)) as sim from public.topics t
     where lower(t.label) operator(extensions.%) lower(q) or t.label ilike q || '%'
    union all
    select t.id, t.label, extensions.similarity(lower(a.alias), lower(q)) from public.topic_aliases a
      join public.topics t on t.id = a.topic_id
     where lower(a.alias) operator(extensions.%) lower(q) or a.alias ilike q || '%'
  )
  select c.id, c.label, max(c.sim)::real,
         (select count(*) from public.disco_topics dt where dt.topic_id = c.id and dt.user_id = auth.uid())
  from cand c group by c.id, c.label
  order by 4 desc, 3 desc limit greatest(1, least(max_results, 25));
$$;
revoke all on function public.suggest_tags(text, int) from public, anon;
grant execute on function public.suggest_tags(text, int) to authenticated;
