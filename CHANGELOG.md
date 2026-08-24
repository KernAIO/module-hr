# @kernhq/module-hr

## 0.2.0

### Minor Changes

- 767c9e8: Add the HR module: people, offices, org chart and holiday calendars.

  A staff directory with effective-dated employment records, an ltree org chart, positions, employee
  documents and custom fields — plus the two things that make it work for a company with more than one
  place of work:

  **Offices are the unit of inheritance.** A workspace always has exactly one, built from its country
  when HR is enabled, so turning the `offices` capability on is a reveal rather than a migration and
  nothing has a "no office" branch. A person may hold several concurrently, but exactly one is primary
  and only the primary decides holidays, timezone and policy — otherwise "how many days off do I have"
  has two answers. `offices.resolveFor` reports which rung of the ladder answered, so a support
  question does not need a database session.

  **Calendars compose rather than copy.** An office calendar `extends` a country pack and its own days
  sit on top, with `source` tracked per day — so a pack refresh replaces pack days and never touches
  one HR added, and `calendars.pack.preview` lists what survives before anything is applied. Six packs
  ship (TR, DE, GB, US, NL, IR) as data with their sources named; Iran's Friday weekend and half
  Thursday are why the working week is a calendar field rather than an assumption.

  Capabilities: `core` (required), `offices`, `legal_entities`, `calendars`, `documents`. Declared only
  where something is behind them.

  The invariants are database constraints, not application code: one default office per workspace, no
  overlapping employment rows, one primary office per person per day.
