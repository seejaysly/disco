-- Tuning for suggest_tags_for_capture after testing on CJ's discos (Oct 17).
-- Applied as small in-place rewrites of the function body so each change is easy to see.

-- 1. Vocabulary discos don't count as "similar", and a similar-disco tag needs at least two
--    similar discos agreeing on it (at most 3 such suggestions).
do $$
declare d text := pg_get_functiondef('public.suggest_tags_for_capture'::regproc);
begin
  d := replace(d, E'     where d.user_id = me.uid\n  ),\n  n_discos', E'     where d.user_id = me.uid and d.kind <> ''vocabulary''\n  ),\n  n_discos');
  d := replace(d, 'select topic_id, score from sim_tags order by n desc, score desc limit 4',
                  'select topic_id, score from sim_tags where n >= 2 order by n desc, score desc limit 3');
  if d not like '%n >= 2 order by%' or d not like '%kind <> ''vocabulary''%' then
    raise exception 'replace did not apply';
  end if;
  execute d;
end $$;

-- 2. A past disco is "similar" only when it shares at least three rare words with the passage.
do $$
declare d text := pg_get_functiondef('public.suggest_tags_for_capture'::regproc);
begin
  d := replace(d, E'     group by dl.id\n    having count(*) >= 2', E'     group by dl.id\n    having count(*) >= 3');
  if d not like '%having count(*) >= 3%' then raise exception 'replace did not apply'; end if;
  execute d;
end $$;

-- 3. One-word tags also match their plural or singular in the passage
--    ("memories" finds "memory"), without looser word-stem matches ("extremely" ≠ "extremism").
do $$
declare d text := pg_get_functiondef('public.suggest_tags_for_capture'::regproc);
declare e int;
begin
  e := position('  ranked as (' in d);
  if e = 0 then raise exception 'marker not found'; end if;
  d := left(d, e - 1) ||
E'  -- one-word tags also match their plural or singular ("memories" finds "memory", "black hole" stays exact)\n' ||
E'  stem_hits as (\n' ||
E'    select mt.topic_id, mt.uses::real as score\n' ||
E'      from my_topics mt join public.topics t on t.id = mt.topic_id\n' ||
E'     where t.label ~ \'^[[:alpha:]]+$\' and length(t.label) >= 4\n' ||
E'       and coalesce(p_passage, \'\') ~* (\'\\m\' || case\n' ||
E'             when t.label ~* \'[^aeiou]y$\' then left(t.label, -1) || \'(y|ies)\'\n' ||
E'             when t.label ~* \'(s|x|ch|sh)$\' then t.label || \'(es)?\'\n' ||
E'             when t.label ~* \'s$\' then t.label\n' ||
E'             else t.label || \'s?\' end || \'\\M\')\n' ||
E'  ),\n' ||
  substr(d, e);
  d := replace(d, E'    union all select topic_id, 2, score, \'in_passage\' from in_passage\n',
                  E'    union all select topic_id, 2, score, \'in_passage\' from in_passage\n    union all select topic_id, 2, score, \'in_passage\' from stem_hits\n');
  if d not like '%from stem_hits%' then raise exception 'replace did not apply'; end if;
  execute d;
end $$;
