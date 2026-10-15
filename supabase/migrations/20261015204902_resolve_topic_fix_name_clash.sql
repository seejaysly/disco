-- The OUT parameters topic_id and label clashed with column names; found by the rollback test.
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
