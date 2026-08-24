import type { Tx } from '@kernhq/kernel'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

/** Today in UTC as `YYYY-MM-DD`. Callers wanting a person's local today pass their zone instead. */
export const todayIso = () => new Date().toISOString().slice(0, 10)

/** `YYYY-MM-DD` in a given IANA zone — what "today" means for somebody in Istanbul at 01:00 UTC. */
export function todayIn(timezone: string, at: Date = new Date()): string {
  // `en-CA` formats as YYYY-MM-DD, which is the one locale that gives an ISO date for free.
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at)
}

/**
 * The predicate for "this effective-dated row was in force on `on`".
 *
 * `effective_from <= on AND (effective_to IS NULL OR effective_to >= on)`. Written once because it
 * appears in every read of `employments` and `office_assignments`, and getting the boundary wrong by
 * a day is the kind of bug that only shows up on somebody's last day of employment.
 */
export const inForceOn = (from: PgColumn, to: PgColumn, on: string) =>
  and(lte(from, on), or(isNull(to), sql`${to} >= ${on}`))

/** The currently open row: no end date at all. */
export const isOpen = (to: PgColumn) => isNull(to)

/** Narrow anything to one workspace. Every query in this module starts here. */
export const inWorkspace = (col: PgColumn, workspaceId: string) => eq(col, workspaceId)

/** Postgres `numeric` comes back as a string; every ratio in this module is a real number. */
export const num = (v: string | number | null | undefined, fallback = 0): number =>
  v === null || v === undefined ? fallback : typeof v === 'number' ? v : Number.parseFloat(v)

export type { Tx }
