/**
 * What HR offers, as data.
 *
 * Imported by **both** halves — the server implements it, the client calls it — so nothing here may
 * touch Node. The contract is the only thing that crosses that line, which is why a procedure that
 * exists here and not in the router is a lie that compiles. `module.test.ts` checks exactly that,
 * and also that every procedure listed in `hrCapabilityProcedures` carries its capability guard.
 */
export * from './capabilities.js'
export * from './events.js'
export * from './models.js'
export * from './permissions.js'
export * from './router.js'
export * from './settings.js'
