import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const libraryRoot = sqliteTable('library_root', {
  id: integer().primaryKey(),
  path: text().notNull().unique(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
})

export const file = sqliteTable(
  'file',
  {
    id: integer().primaryKey(),
    rootId: integer('root_id').notNull().references(() => libraryRoot.id, { onDelete: 'restrict' }),
    relPath: text('rel_path').notNull(),
    quickFp: text('quick_fp').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    modifiedAt: integer('modified_at').notNull(),
  },
  (table) => [
    uniqueIndex('file_root_rel_path_idx').on(table.rootId, table.relPath),
    index('file_quick_fp_idx').on(table.quickFp),
    check('file_size_nonnegative', sql`${table.sizeBytes} >= 0`),
  ],
)
