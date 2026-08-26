---
'@kernhq/module-hr': minor
---

The approvals inbox names who is asking and reads in the approver's language. An approval request now
carries its requester as an employee (`requesterPersonId`, resolved to a display name on read — the
old `requestedBy` was a user id, and employees need not have accounts) and its summary as data
(`summaryParams`), so the row renders in the reader's locale instead of the sentence the server
composed in English. `summary` stays as the fallback for rows raised before this migration.

Decisions are confirmed in a dialog that says what the decision actually does to whom — approving
leave spends somebody's balance, a middle step only passes the request on — rather than asking a bare
"are you sure". A person may delegate their queue to a colleague for a window of dates: the request
appears in the delegate's inbox, a decision made through the delegation records both names against
the step, and only the person who delegated may revoke it. Delegating is gated behind a new
`hr.approval.delegate` permission; deciding stays ungated, because your own inbox is yours.

Offices move from cards to a table — office, type, country, headcount, current local time read down
columns — with stat tiles above and a settings shortcut for people who may manage them.
