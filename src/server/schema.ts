import { moduleSchema } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'
import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * This module's tables, in its own Postgres schema.
 *
 * Two rules, neither optional:
 *
 * - every tenant table carries `workspace_id` and an index that starts with it;
 * - every tenant table gets a row-level security policy, hand-written in the migration, because
 *   drizzle-kit does not generate one. RLS is the last line — the API check is the first, and
 *   somebody will eventually write a query that skips it.
 */
export const schema = moduleSchema('hr')

export const notes = schema.table(
  'notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    workspaceId: uuid('workspace_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Added by migration 0002, nullable — which is the rule, not a preference. Every migration must
     * leave the database readable by the image before it, so a rollback does not need a dump.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('notes_ws_idx').on(t.workspaceId, t.createdAt)],
)

/** Every tenant table, so the RLS migration can be checked against one list rather than memory. */
export const TENANT_TABLES = ['notes'] as const
