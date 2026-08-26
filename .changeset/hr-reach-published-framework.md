---
'@kernhq/module-hr': patch
---

Publish the framework ranges that were corrected but never shipped.

The manifest already said `@kernhq/contracts ^0.6.0` and `@kernhq/ui ^0.10.0`, and `check-ranges`
was green on it — but 0.10.0 on npm still declared `contracts ^0.5.1` and `ui ^0.8.0`, because the
correction landed without a changeset and so could not be released. Every host resolving this module
today gets the old peers, and no check could see it: the repository looks right, the registry is not.

The committed lockfile was stale against the same edit, which is what the last publish actually died
on — `--frozen-lockfile` compares specifiers, so a corrected range fails install before anything is
built.
