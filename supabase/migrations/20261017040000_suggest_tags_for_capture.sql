-- Tag suggestions for the capture panel (Phase 3).
-- Given the passage being saved (and the page it came from), suggest tags in this order:
--   1. same_page  : tags the user already put on other discos from this same page
--   2. in_passage : topics the user has tagged before whose name (or alias, or a person's
--                   surname) appears in the passage as a whole word
--   3. similar    : tags from the user's most similar past discos (full-text match for now;
--                   embeddings replace this later)
-- Never suggests the source's own author, nor a parent of an equally strong suggestion.
-- Runs as the caller, so row-level security limits everything to the user's own discos.

create or replace function public.suggest_tags_for_capture(
  p_passage text,
  p_url text default null,
  p_author text default null,
  max_results integer default 8
)
returns table(topic_id uuid, label text, hint text, reason text)
language sql
stable
set search_path to ''
as $function$
  with me as (select auth.uid() as uid),
  norm_url as (
    select nullif(rtrim(regexp_replace(lower(coalesce(p_url, '')), '[?#].*$', ''), '/'), '') as u
  ),
  my_topics as (
    select dt.topic_id, count(*) as uses
      from public.disco_topics dt, me
     where dt.user_id = me.uid
     group by dt.topic_id
  ),
  -- 1. tags on other discos from the same page
  same_page as (
    select dt.topic_id, count(*)::real as score
      from public.discos d
      join public.disco_topics dt on dt.disco_id = d.id
      cross join norm_url n
      cross join me
     where n.u is not null
       and d.user_id = me.uid
       and rtrim(regexp_replace(lower(coalesce(d.url, '')), '[?#].*$', ''), '/') = n.u
     group by dt.topic_id
  ),
  -- 2. names the user has tagged before, found in the passage
  names as (
    select mt.topic_id, t.label as name, mt.uses from my_topics mt join public.topics t on t.id = mt.topic_id
    union all
    select mt.topic_id, a.alias, mt.uses from my_topics mt join public.topic_aliases a on a.topic_id = mt.topic_id
    union all
    -- a person's surname alone ("Kafka", "Hawking"), when it is long enough to be distinctive
    select mt.topic_id, substring(t.label from '([^ ]+)$'), mt.uses
      from my_topics mt join public.topics t on t.id = mt.topic_id
     where t.kind = 'person' and t.label like '% %' and length(substring(t.label from '([^ ]+)$')) >= 4
  ),
  in_passage as (
    select n.topic_id, max(n.uses)::real as score
      from names n
     where length(n.name) >= 3
       and coalesce(p_passage, '') ~* ('\m' || regexp_replace(n.name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M')
     group by n.topic_id
  ),
  -- 3. tags from the most similar past discos
  -- words of 4+ letters in the passage (stemmed), ignoring common words
  plex as (
    select distinct v.lex
      from unnest(to_tsvector('english', left(coalesce(p_passage, ''), 20000))) as v(lex, positions, weights)
     where length(v.lex) >= 4
  ),
  -- every distinctive word in the user's discos, once per disco
  disco_lex as (
    select d.id, dv.lex
      from public.discos d
      cross join me
      cross join lateral unnest(to_tsvector('english', coalesce(d.quote, '') || ' ' || coalesce(d.text_captured, ''))) as dv(lex, positions, weights)
     where d.user_id = me.uid
  ),
  n_discos as (select greatest(count(distinct id), 1) as n from disco_lex),
  -- passage words that are rare in the user's discos (common words say little about a topic)
  rare as (
    select p.lex, count(distinct dl.id) as df
      from plex p join disco_lex dl on dl.lex = p.lex
     group by p.lex
    having count(distinct dl.id) <= greatest(4, (select n from n_discos) / 50)
  ),
  similar_discos as (
    select dl.id, sum(1.0 / r.df)::real as r
      from disco_lex dl join rare r on r.lex = dl.lex
     group by dl.id
    having count(*) >= 2
     order by 2 desc
     limit 6
  ),
  sim_tags as (
    select dt.topic_id, sum(s.r)::real as score, count(*) as n
      from similar_discos s join public.disco_topics dt on dt.disco_id = s.id
     group by dt.topic_id
  ),
  sim_top as (
    select topic_id, score from sim_tags order by n desc, score desc limit 4
  ),
  ranked as (
    select topic_id, 1 as tier, score, 'same_page' as reason from same_page
    union all select topic_id, 2, score, 'in_passage' from in_passage
    union all select topic_id, 3, score, 'similar' from sim_top
  ),
  best as (
    select distinct on (r.topic_id) r.topic_id, r.tier, r.score, r.reason
      from ranked r
     order by r.topic_id, r.tier, r.score desc
  ),
  filtered as (
    select b.*, t.label, t.parent_id
      from best b join public.topics t on t.id = b.topic_id
     where p_author is null
        or (lower(t.label) <> lower(p_author)
            and not exists (select 1 from public.topic_aliases a where a.topic_id = t.id and lower(a.alias) = lower(p_author)))
  )
  select f.topic_id, f.label, private.topic_hint(f.topic_id), f.reason
    from filtered f
   where not exists (select 1 from filtered c where c.parent_id = f.topic_id and c.tier <= f.tier)
   order by f.tier, f.score desc, f.label
   limit greatest(1, least(coalesce(max_results, 8), 20));
$function$;

revoke execute on function public.suggest_tags_for_capture(text, text, text, integer) from public, anon;
grant execute on function public.suggest_tags_for_capture(text, text, text, integer) to authenticated;
