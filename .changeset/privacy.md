---
'@kernhq/module-hr': minor
---

Subject access, erasure that redacts, retention per data class, and a record of who read a national
identity number.

BREAKING CHANGE: `Person` gains `erasedAt`. Erasure is redaction, so an erased record still appears —
in a headcount, behind a ledger entry, as the subject of a two-year-old approval — and a screen that
cannot tell it from an ordinary row shows a blank name and reads as broken.

**`privacy.subjectAccess`** returns what the module holds about one person: the record, the decrypted
sensitive fields, employment, offices, history with its values, document metadata, leave with its
ledger and closing balance, attendance, approvals both raised and decided, delegations in both
directions, the policies in force, the access log — and a `manifest` naming what was truncated and
what was excluded, because a bundle that quietly stops at a limit is a worse answer than one that
says where it stopped.

**`privacy.erase` deletes nothing.** Not one `delete` statement: every step writes through the same
predicate — rows that still have something to clear — which is what makes the dry run unable to
drift from the act, and a second run a no-op that leaves the first tombstone date alone. `dryRun`
defaults to **true**, because core generates MCP tools from module OpenAPI and the no-argument call
had to be the harmless one. `national_id_enc` and `iban_enc` are set to null rather than orphaned
from their key: ciphertext whose key is still in `KERN_SECRET` is data behind one environment
variable.

Two limits are stated rather than implied. **Erasure makes somebody anonymous to a reader of Kern,
not to a payroll system** — `employee_no` survives because it is the payroll join key, so anyone
holding that number and a copy of the payroll can still re-identify an erased person. The stronger
version costs the join and belongs to a workspace, not to a default. And **there is no `files.delete`
a module can reach**, so document objects survive and the orphaned photo and sick-note ids are
recorded in `people.erased_file_ids` for a release that can finish it.

**Retention** is eight nullable horizons, every one shipping `null`: no legal number is a default,
and Kern gives no legal advice. Nothing sweeps on a timer — `sweepEnabled` is a literal `false` —
and the horizons are read in the two places that ship today, `retention.get` counting what has passed
each one and `erase` citing them in what it kept. Leave retention is per closed `period_year` rather
than a date cutoff, because ledger rows a live balance cursor still sums over cannot be removed by a
date.

**`sensitive_access_log`** records who read an identity number, a birth date or a bank account.
`kernel.secrets.decrypt` on those columns now exists in exactly one place in the module, five lines
above the insert that records it, so the export path cannot forget to log. A logging failure fails
the read: the insert shares a transaction, a database and a connection with the select, so there is
no state where the read is healthy and the log alone fails — and a subject-access response built on a
log with silent holes states in writing that nobody read a record that was read. It is filed here
rather than in core's activity log because `core.audit.view` is an owner/admin default while
`hr.person.view_sensitive` is held by nobody, so core would publish it to a wider audience than the
data itself.

`privacy.accessLog.list` is self-service about yourself and therefore has no procedure-level
permission — reading who looked at your own bank details is not a thing anybody may lack.
`hr.privacy.manage` is required for somebody else's log, and for any query by actor, which is an
investigation rather than a question about yourself.

**Fixes a live defect found on the way:** `custom_field_defs.sensitive` was declared, stored,
editable and documented as needing `hr.person.view_sensitive` — and nothing read it, so a field an
administrator marked sensitive went to every holder of `hr.person.view`, a member default.
