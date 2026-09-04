---
'@kernhq/module-hr': patch
---

Rename every client query key onto the entity name the server announces, so the realtime client's `[module, entity]` prefix invalidation reaches screens it previously never reached. The sensitive-fields panel is deliberately left off that prefix: the server logs every read, and a refetch nobody asked for would record a disclosure nobody performed.
