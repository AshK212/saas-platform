import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { sessionStatus, taskStatus } from './enums.js';
import { runtimeProfiles } from './runtime.js';
import { workspaces } from './workspaces.js';

/**
 * Runtime sessions - hybrid-safe schema only.
 *
 * Exists so that adding a runtime adapter later does not require rewriting the
 * agent model. No orchestration, routing, delegation or conversation memory is
 * implemented, and none is modelled here.
 *
 * Mirrors the `Session` type in @hybrid/runtime-core: a session is bound to
 * exactly one workspace and one agent. Both links are composite, so a session
 * cannot straddle workspaces.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').notNull(),
    runtimeProfileId: uuid('runtime_profile_id'),
    status: sessionStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of the composite foreign key from tasks.
    unique('sessions_workspace_id_id_key').on(table.workspaceId, table.id),
    foreignKey({
      name: 'sessions_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'sessions_workspace_runtime_profile_fkey',
      columns: [table.workspaceId, table.runtimeProfileId],
      foreignColumns: [runtimeProfiles.workspaceId, runtimeProfiles.id],
    }).onDelete('restrict'),
    index('sessions_workspace_agent_idx').on(table.workspaceId, table.agentId),
  ],
);

/**
 * Runtime tasks - hybrid-safe schema only.
 *
 * Mirrors the `Task` type in @hybrid/runtime-core. `agent_id` is carried
 * directly as well as via the session so that per-agent task queries need no
 * join, and both links are composite and workspace-anchored.
 *
 * DELIBERATELY OMITTED: result and error columns. `TaskResult` persistence is
 * not required until a runtime adapter exists to write it, and adding nullable
 * columns later is a trivial migration. Modelling them now would be a
 * speculative orchestration column with no writer.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    agentId: uuid('agent_id').notNull(),
    status: taskStatus('status').notNull().default('pending'),

    /** Runtime-agnostic description of the work requested. */
    instruction: text('instruction').notNull(),

    /** Opaque, runtime-interpreted parameters. Open by design. */
    input: jsonb('input'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'tasks_workspace_session_fkey',
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessions.workspaceId, sessions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tasks_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),
    index('tasks_workspace_session_idx').on(table.workspaceId, table.sessionId),
  ],
);
