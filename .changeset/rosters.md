---
'@kernhq/module-hr': minor
---

Rosters: named shifts, rotating patterns, per-person assignment and one-day overrides, behind a
`rosters` capability.

**A roster is keyed by the calendar, not by weekday.** `ScheduleWeek` repeats every seven days, so a
4-on-4-off rotation — or any two- or three-week cycle — has no weekly period and cannot be expressed
at any length. That is the one thing schedules cannot do, and the only structural reason rosters
exist. Everything else people call rostering was already built and is not rebuilt: hours, grace,
rounding, overnight shifts, night-shift business-date attribution, the auto-close sweep, the
locked-period repair. A roster feeds the one seam, `ResolvedSchedule.shiftFor(date)`.

**The rotation is computed, never stored per day.** A pattern is a cycle of days plus the date its
first day falls on; what somebody works on any date is arithmetic. Storing a year of generated
shifts per person is what makes a roster impossible to change afterwards — only exceptions are rows.

`roster_assignments` carries a `cycle_offset` so two crews can share one rotation out of phase, and
an exclusion constraint against overlap from the day the table exists rather than five migrations
later, which is how `schedule_assignments` got its own.

**What is deliberately not here.** The IP allowlist is not shipped at all: `trustProxy: true` makes
the client address a header anyone can forge, so an allowlist would be defeated by one line while an
administrator believed punches were pinned to the office. Kiosk and QR need a device credential
store that does not exist. Offline sync's server half is already built — `clientReportedAt`,
`skewMs`, the disputed threshold, the idempotency index — and the missing half is a client that
queues, which a module cannot ship. Biometric import needs a named vendor SDK; what could be built
honestly instead is a CSV punch import, which is a different feature with an honest name.
