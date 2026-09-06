---
'@kernhq/module-hr': patch
---

Give the seeded leave types icons that exist.

`palmtree`, `thermometer`, `baby` and `circle-minus` are all real lucide icons and none of them is
in `@kernhq/ui`'s registry, which is a hand-maintained subset — so each rendered as a blank square
with nothing thrown. `scripts/check-icons.mjs` is the only thing that sees this, and it is the
reason it exists.
