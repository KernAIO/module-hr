---
'@kernhq/module-hr': patch
---

Constrain every workspace-scoped query to its workspace, closing a class of cross-tenant IDOR.

**A bare `eq(table.id, input.something)` inside a workspace-scoped transaction is not scoped to
anything.** The transaction sets `app.workspace_id`, which is what row-level security reads — but
RLS is inert wherever the service connects as the Postgres superuser, and that is every deployment
today. So the predicate the query does not state is the only one there was. Four of these were
reachable with nothing but an id belonging to somebody else:

- `hr.person.get` returned an employee's id, account, display name and status for any workspace the
  caller named. It answers null for a person outside the workspace now.
- `hr.person.byUserId` matched on `user_id` alone. That column is deliberately **not** unique across
  workspaces — the same account legitimately holds a record in several — so the query was both a
  leak and a coin toss: it answered with whichever row Postgres returned first.
- `core.member.removed` cleared `people.user_id` wherever it matched, so leaving one workspace
  detached that person's record in every other one. An employment file outlives an account, and it
  must not lose its link for a reason that happened somewhere else.
- `calendars.pack.apply` never proved the calendar was the caller's. It reported an empty diff while
  writing `pack_key`, `pack_version` and a year of holidays onto a calendar in another workspace.
  `diffPack` loads the calendar first now, so `preview` and `apply` both answer **not found** —
  never `forbidden`, which would confirm the calendar exists.

The approval decision path, the leave and regularization appliers, the org-unit move, the chain
update and the effective-dated employment and office writes in `people.ts` are corrected the same
way. Those were not exploitable — each id had already been proven by a workspace-scoped load — but
every one of them would have started silently matching nothing the moment RLS began to bite.

`src/server/isolation.test.ts` proves the class is closed rather than the four cases: it seeds two
workspaces and asserts that an id belonging to A is neither readable nor mutable from B, at the
service layer *and* under an explicit `nosuperuser nobypassrls` Postgres role — the only role that
can tell a working policy from a missing one, since a superuser bypasses every policy and would pass
these assertions against tables carrying none.
