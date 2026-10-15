-- Phase 2: the Coda -> Supabase copy. scripts/coda-import/build.py writes the data as JSON parts
-- into private.coda_staging; private.coda_import_apply(batch, email) upserts it for that user.
-- Every row is matched by a natural key, so re-running updates instead of duplicating (this is
-- also the final re-copy at cutover). Until cutover Coda is the source of truth: discos deleted
-- in Coda are removed here, re-tagged discos get Coda's tags, and imported guides are rebuilt.

create table private.coda_staging (
  batch text not null,
  part int not null,
  kind text not null,
  payload jsonb not null,
  loaded_at timestamptz not null default now(),
  primary key (batch, part)
);
revoke all on private.coda_staging from public, anon, authenticated;

-- A topic reference is a uuid (DIG topics) or 'slug:<slug>' (topics the import creates).
create or replace function private.coda_ref(p text)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when p like 'slug:%' then (select id from public.topics where slug = substr(p, 6))
              when p is null then null else p::uuid end;
$$;

create or replace function private.coda_import_apply(p_batch text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_counts jsonb := '{}'::jsonb;
  r jsonb; it jsonb;
  v_id uuid; v_src uuid; v_art uuid; v_disco uuid; v_guide uuid; v_ed uuid; v_item uuid;
  v_rank double precision;
  v_n int;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then raise exception 'no user with email %', p_email; end if;

  create temp table imp on commit drop as
    select kind, e.value as j from private.coda_staging s, jsonb_array_elements(s.payload) e
     where s.batch = p_batch;
  create temp table src_map (key text primary key, id uuid) on commit drop;
  create temp table art_map (hash text primary key, id uuid) on commit drop;
  create temp table disco_map (coda_row_id text primary key, id uuid) on commit drop;

  -- topics (shared catalog)
  insert into public.topics (slug, label, kind, parent_id, created_by)
  select j->>'slug', j->>'label', j->>'kind', (j->>'parent_id')::uuid, v_uid from imp where kind = 'topics'
  on conflict (slug) do update set label = excluded.label, kind = excluded.kind, parent_id = excluded.parent_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('topics', v_n);

  insert into public.topic_aliases (topic_id, alias)
  select private.coda_ref(j->>'ref'), j->>'alias' from imp where kind = 'aliases'
  on conflict do nothing;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('aliases', v_n);

  insert into public.topic_links (topic_id, related_id, relation)
  select private.coda_ref(j->>'ref'), private.coda_ref(j->>'related'), j->>'relation' from imp
   where kind = 'links' and private.coda_ref(j->>'ref') <> private.coda_ref(j->>'related')
  on conflict do nothing;

  -- sources (shared catalog): books by Coda row id, outlets by domain or name
  for r in select j from imp where kind = 'sources' loop
    v_id := null;
    if r->>'coda_row_id' is not null then
      select id into v_id from public.sources where coda_row_id = r->>'coda_row_id';
    elsif r->>'domain' is not null then
      select id into v_id from public.sources where kind = 'outlet' and lower(domain) = lower(r->>'domain');
    else
      select id into v_id from public.sources where kind = r->>'kind' and lower(name) = lower(r->>'name') limit 1;
    end if;
    if v_id is null then
      insert into public.sources (kind, name, author, domain, homepage_url, coda_row_id)
      values (r->>'kind', r->>'name', r->>'author', r->>'domain',
              case when r->>'domain' is not null then 'https://' || (r->>'domain') end, r->>'coda_row_id')
      returning id into v_id;
    else
      update public.sources set name = coalesce(r->>'name', name), author = coalesce(r->>'author', author)
       where id = v_id;
    end if;
    insert into src_map values (r->>'key', v_id) on conflict do nothing;
  end loop;

  -- articles (shared catalog), keyed by md5 of the cleaned URL
  insert into public.articles (url, url_hash, headline, source_id, published_at)
  select j->>'url', j->>'hash', j->>'headline', m.id, (j->>'published')::timestamptz
    from imp left join src_map m on m.key = j->>'source_key' where kind = 'articles'
  on conflict (url_hash) do update set headline = coalesce(public.articles.headline, excluded.headline),
    source_id = coalesce(public.articles.source_id, excluded.source_id),
    published_at = coalesce(public.articles.published_at, excluded.published_at);
  insert into art_map select a.url_hash, a.id from public.articles a
    where a.url_hash in (select j->>'hash' from imp where kind = 'articles');

  -- discos (personal), matched by Coda row id
  insert into public.discos (user_id, kind, quote, text_captured, details, url, source_id, article_id,
                             captured_at, capture_method, coda_row_id)
  select v_uid, j->>'kind', j->>'quote', j->>'text_captured', coalesce(j->'details', '{}'), j->>'url',
         sm.id, am.id, coalesce((j->>'captured_on')::date + time '12:00', now()), 'migrated', j->>'coda_row_id'
    from imp left join src_map sm on sm.key = j->>'source_key'
             left join art_map am on am.hash = j->>'article_hash'
   where kind = 'discos'
  on conflict (user_id, coda_row_id) do update set kind = excluded.kind, quote = excluded.quote,
    text_captured = excluded.text_captured, details = excluded.details, url = excluded.url,
    source_id = excluded.source_id, article_id = excluded.article_id, captured_at = excluded.captured_at,
    updated_at = now();
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('discos', v_n);
  insert into disco_map select coda_row_id, id from public.discos where user_id = v_uid and coda_row_id is not null;

  -- discos deleted in Coda since the last copy
  delete from public.discos d where d.user_id = v_uid and d.capture_method = 'migrated' and d.coda_row_id is not null
     and not exists (select 1 from imp where kind = 'discos' and j->>'coda_row_id' = d.coda_row_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('discos_removed', v_n);

  -- tags: Coda's version wins for migrated discos
  create temp table want on commit drop as
    select dm.id as disco_id, private.coda_ref(t.value #>> '{}') as topic_id
      from imp join disco_map dm on dm.coda_row_id = j->>'coda_row_id', jsonb_array_elements(j->'tags') t
     where kind = 'discos';
  delete from public.disco_topics dt using disco_map dm
   where dt.user_id = v_uid and dt.disco_id = dm.id
     and not exists (select 1 from want w where w.disco_id = dt.disco_id and w.topic_id = dt.topic_id);
  insert into public.disco_topics (user_id, disco_id, topic_id)
  select distinct v_uid, disco_id, topic_id from want where topic_id is not null on conflict do nothing;
  select count(*) into v_n from public.disco_topics where user_id = v_uid;
  v_counts := v_counts || jsonb_build_object('disco_topics', v_n);

  -- knowledge guides: one per topic, rebuilt in Coda's order with headers and notes
  v_n := 0;
  for r in select j from imp where kind = 'guides' loop
    v_id := private.coda_ref(r->>'ref');
    insert into public.guides (owner_id, kind, topic_id, title)
    select v_uid, 'topic', v_id, t.label from public.topics t where t.id = v_id
    on conflict (owner_id, topic_id) where topic_id is not null do update set updated_at = now()
    returning id into v_guide;
    continue when v_guide is null;
    delete from public.guide_items where guide_id = v_guide;
    insert into public.guide_items (guide_id, disco_id, header_text, note, rank, added_by)
    select v_guide, dm.id, e.value->>'header', e.value->>'note', e.ordinality, v_uid
      from jsonb_array_elements(r->'items') with ordinality e
      left join disco_map dm on dm.coda_row_id = e.value->>'disco'
     where dm.id is not null or e.value->>'header' is not null;
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('guides', v_n);
  for r in select j from imp where kind = 'source_guides' loop
    select id into v_src from src_map where key = r->>'source_key';
    insert into public.guides (owner_id, kind, source_id, title)
    select v_uid, 'source', v_src, s.name from public.sources s where s.id = v_src
    on conflict (owner_id, source_id) where source_id is not null do update set updated_at = now()
    returning id into v_guide;
    continue when v_guide is null;
    delete from public.guide_items where guide_id = v_guide;
    insert into public.guide_items (guide_id, disco_id, rank, added_by)
    select v_guide, dm.id, e.ordinality, v_uid from jsonb_array_elements_text(r->'items') with ordinality e
      join disco_map dm on dm.coda_row_id = e.value;
  end loop;

  -- feed history from the current Coda feed: editions, articles shown, votes, source choices
  for r in select j from imp where kind = 'editions' loop
    insert into public.editions (user_id, edition_date, variant, published_at)
    values (v_uid, (r->>'edition')::date, 'coda_import', (r->>'edition')::date + time '06:00')
    on conflict (user_id, edition_date, variant) do update set variant = excluded.variant
    returning id into v_ed;
    select id into v_art from art_map where hash = r->>'hash';
    if v_art is not null and not exists (select 1 from public.edition_items where edition_id = v_ed and article_id = v_art) then
      insert into public.edition_items (user_id, edition_id, article_id, topic_id)
      values (v_uid, v_ed, v_art, private.coda_ref(r->>'topic'));
    end if;
  end loop;
  for r in select j from imp where kind = 'votes' loop
    select id into v_art from art_map where hash = r->>'hash';
    select ei.id into v_item from public.edition_items ei join public.editions e on e.id = ei.edition_id
     where ei.user_id = v_uid and ei.article_id = v_art and e.edition_date = (r->>'edition')::date limit 1;
    insert into public.votes (user_id, article_id, edition_item_id, value, created_at)
    values (v_uid, v_art, v_item, (r->>'value')::smallint,
            coalesce(to_timestamp((r->>'ts')::bigint / 1000.0), now()))
    on conflict (user_id, article_id) do update set value = excluded.value, updated_at = now();
  end loop;
  insert into public.user_source_prefs (user_id, source_id, preference)
  select v_uid, m.id, j->>'preference' from imp join src_map m on m.key = j->>'source_key' where kind = 'prefs'
  on conflict (user_id, source_id) do update set preference = excluded.preference;

  -- word of the day progress
  insert into public.vocab_progress (user_id, disco_id, first_shown_on, last_shown_on, times_shown, learned_at)
  select v_uid, dm.id, (j->>'first')::date, (j->>'last')::date, (j->>'times')::int,
         case when (j->>'learned')::boolean then now() end
    from imp join disco_map dm on dm.coda_row_id = j->>'disco' where kind = 'vocab'
  on conflict (user_id, disco_id) do update set first_shown_on = excluded.first_shown_on,
    last_shown_on = excluded.last_shown_on, times_shown = excluded.times_shown,
    learned_at = coalesce(public.vocab_progress.learned_at, excluded.learned_at);

  -- DIG: CJ's submission becomes his topics; Coda's "exclude from newsfeed" topics come in paused.
  -- Existing choices are left alone, so changes made in v2 survive a re-copy.
  select j into r from imp where kind = 'dig' limit 1;
  if r is not null then
    if not exists (select 1 from public.dig_submissions where user_id = v_uid and dig_version = 'v3-sheet') then
      insert into public.dig_submissions (user_id, dig_version, answers, suggested_topic_ids)
      select v_uid, 'v3-sheet', r->'answers', array(select private.coda_ref(x) from jsonb_array_elements_text(r->'refs') x);
    end if;
    insert into public.user_topics (user_id, topic_id, tier, origin)
    select v_uid, private.coda_ref(x), 'rotate', 'dig' from jsonb_array_elements_text(r->'refs') x
    on conflict (user_id, topic_id) do nothing;
  end if;
  insert into public.user_topics (user_id, topic_id, tier, origin)
  select v_uid, private.coda_ref(j #>> '{}'), 'paused', 'coda' from imp where kind = 'paused'
  on conflict (user_id, topic_id) do nothing;

  delete from private.coda_staging where batch = p_batch;
  return v_counts || jsonb_build_object('user_topics', (select count(*) from public.user_topics where user_id = v_uid),
                                        'guide_items', (select count(*) from public.guide_items gi join public.guides g on g.id = gi.guide_id where g.owner_id = v_uid));
end;
$$;
revoke all on function private.coda_import_apply(text, text) from public, anon, authenticated;
revoke all on function private.coda_ref(text) from public, anon, authenticated;
