---
'@kernhq/module-hr': patch
---

The reports page no longer leaves a blank band between the filters and the report — the page's
`.ctl` rule was also reaching the control wrapper inside `Field` and making every filter 160px
tall — and its last column is wide enough for its heading. On the rosters settings, a shift that
crosses midnight reads as two clock times with the "+1" beside them, rather than two full dates
built from an anchor day nobody chose.
