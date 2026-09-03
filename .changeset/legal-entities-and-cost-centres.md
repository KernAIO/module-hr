---
'@kernhq/module-hr': minor
---

Settings → Organization → Entities: legal entities and cost centres are reachable.

A reachability audit found six contract procedures with no caller anywhere: `entities.create`,
`entities.update`, `entities.archive`, `entities.costCenters.list`, `entities.costCenters.create`
and `entities.costCenters.archive`. They were implemented and tested on the server, and
`payroll.export.v1` takes a `legalEntityId` that only `entities.list` can supply — so a fresh
workspace could not run payroll at all, because nothing on the interface could create the employer
the export demands. The demo rows in the dev mock masked it.

The new settings page sits between offices and calendars (order 15), behind the legal-entities
capability and the entity-view permission, with the write actions additionally manage-guarded in
the page, and mirrors the sibling screens: lists with an
include-archived toggle served by one request split client-side, create/edit dialogs matching the
contract inputs, archive behind a typed confirmation for entities (the contract has no unarchive)
and a plain confirm for cost centres, whose rows carry no update — the contract has none, and the
dialog says so. Cost centres hang off an office, an org unit and an employer, each optional. A cost
centre code that is already taken in the workspace is now answered as a conflict with a sentence
naming the problem, rather than as the driver's duplicate-key error.

On the way: the `['hr', 'entities', ws]` cache key was shared by five screens asking with different
`includeArchived` values, so whichever rendered first decided what the others saw — an archived
employer offered in the office picker. The archived-asking screens now use their own keys
(`entitiesAll`, `officesAll`, `costCenters`), and every key here is named after the entity the
router announces — `legal_entity`, `cost_center` — because the realtime client invalidates by that
prefix and a key named after the screen is never refetched when somebody else writes. The
country/currency lists OfficesSettings carried are extracted to `countries.ts` for the new form to
share.
