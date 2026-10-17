-- Same-page suggestions favor the tags on the most recent saves from the page (not the most common),
-- and take at most 6 slots so tags from the passage itself still get suggested.
do $$
declare d text := pg_get_functiondef('public.suggest_tags_for_capture'::regproc);
begin
  d := replace(d, E'    select dt.topic_id, count(*)::real as score\n      from public.discos d\n      join public.disco_topics dt on dt.disco_id = d.id',
                  E'    select dt.topic_id, (extract(epoch from max(d.created_at)) / 86400.0)::real as score\n      from public.discos d\n      join public.disco_topics dt on dt.disco_id = d.id');
  d := replace(d, E'    select topic_id, 1 as tier, score, \'same_page\' as reason from same_page\n',
                  E'    select topic_id, 1 as tier, score, \'same_page\' as reason from (select * from same_page order by score desc limit 6) sp\n');
  if d not like '%86400.0%' or d not like '%limit 6) sp%' then raise exception 'replace did not apply'; end if;
  execute d;
end $$;
