# Pending: needs CJ to run in the Supabase SQL editor

Database changes containing DROP need an approval prompt that this Claude session can't show, so
they're parked here. `finish_context_aware_names.sql` removes the old one-topic-per-alias rule
(so "Freud" can point to both Sigmund and Lucian) and the unused two-argument resolve_topic.
After it runs, save it into `supabase/migrations/` with its version.
