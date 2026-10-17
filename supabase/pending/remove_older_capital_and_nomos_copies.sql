-- Remove three older copies of passages from "Capital and Nomos" that CJ re-saved on Oct 17.
-- Their knowledge-guide spots were already moved to the newer copies; this also clears guide spots
-- on topics the newer copies aren't tagged with. Paste into the Supabase SQL editor and Run.
begin;
delete from public.guide_items gi using public.guides g
 where g.id = gi.guide_id and g.kind = 'topic'
   and gi.disco_id in ('ee9bfd82-464e-4c9d-bbc3-5f850927c786','ac270ebb-2bb5-475b-abd6-7928a06b6b47','5dfbb4ed-3a4b-4fbd-881b-f788f7492479')
   and not exists (select 1 from public.disco_topics dt where dt.disco_id = gi.disco_id and dt.topic_id = g.topic_id);
delete from public.discos
 where id in ('0645ebb0-6c7a-4e72-b676-f72e619a89c4','a362dddf-c698-45d1-90c1-f3f198ac18d0','492cfa99-0b2d-4f9f-bc0a-2d80d3f05fc9');
commit;
