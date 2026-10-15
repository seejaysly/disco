-- Lets one short name point to several topics ("Freud" → Sigmund Freud and Lucian Freud),
-- and removes the old version of the tag-matching function that nothing uses any more.
drop index if exists public.topic_aliases_alias_uidx;
drop function if exists private.resolve_topic(text, uuid);
