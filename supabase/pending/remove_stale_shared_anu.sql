-- Remove the leftover SHARED "Anu" topic (slug 'anu').
-- It was created by the first import run, before Anu was made a private, personal tag.
-- It is used by no disco and no guide, but as a shared topic every Disco user could see the name.
-- CJ's own private "Anu" topic (slug 'anu-515343d4') is not touched.
delete from public.topics
where id = '04db85f1-412b-4cfa-9a83-e0e03377d772'
  and slug = 'anu'
  and owner_id is null
  and not exists (select 1 from public.disco_topics dt where dt.topic_id = '04db85f1-412b-4cfa-9a83-e0e03377d772');
