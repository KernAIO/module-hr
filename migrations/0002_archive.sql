-- The column behind the `archive` capability.
--
-- Nullable and additive, because every migration must leave the database readable by the image
-- before it: the previous release simply never selects this column. Dropping or renaming waits at
-- least one release. This is also why a capability can be switched off without losing anything —
-- the flag changes, the column and its data stay.
alter table "mod_hr"."notes" add column if not exists "archived_at" timestamp with time zone;
