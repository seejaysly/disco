# Pending database changes

Written but NOT yet applied to the Disco feed project. Once applied, move the file into
`supabase/migrations/` named with the version Supabase records for it.

- `context_aware_names.sql`: one alias may point to several topics (Freud → Sigmund or Lucian);
  capture picks by the person's habits and the disco's other tags and returns alternatives;
  tag suggestions gain a hint. Two apply attempts on Oct 15 were cancelled before running.
