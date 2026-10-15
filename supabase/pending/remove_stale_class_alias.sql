-- "class" was first imported as another name for Social class; CJ meant "classy" (Oct 15), so it is
-- now its own topic. This removes the leftover alternate name. Safe to run any time.
delete from public.topic_aliases a using public.topics t
 where t.id = a.topic_id and t.label = 'Social class' and lower(a.alias) = 'class';
