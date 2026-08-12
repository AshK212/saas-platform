import { relations } from 'drizzle-orm';

import { agents } from './agents.js';
import { blocks } from './blocks.js';
import { apiCredentials } from './credentials.js';
import { events } from './events.js';
import { users } from './identity.js';
import { ledgerDaily } from './ledger.js';
import { agentPolicies, workspacePolicyState } from './policy.js';
import { precheckReceipts } from './receipts.js';
import { runtimeProfiles } from './runtime.js';
import { sessions, tasks } from './sessions.js';
import { shareTokens } from './sharing.js';
import { workspaces, workspaceMemberships } from './workspaces.js';

/**
 * Drizzle relation metadata.
 *
 * These declarations power the relational query API. They are descriptive
 * only - they emit no SQL and enforce nothing. Every isolation guarantee in
 * this schema comes from the composite foreign keys defined alongside each
 * table, never from these relations.
 */

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMemberships),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  memberships: many(workspaceMemberships),
  apiCredentials: many(apiCredentials),
  shareTokens: many(shareTokens),
  runtimeProfiles: many(runtimeProfiles),
  agents: many(agents),
  events: many(events),
  policyState: one(workspacePolicyState),
}));

export const workspaceMembershipsRelations = relations(workspaceMemberships, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMemberships.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMemberships.userId],
    references: [users.id],
  }),
}));

export const apiCredentialsRelations = relations(apiCredentials, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [apiCredentials.workspaceId],
    references: [workspaces.id],
  }),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [shareTokens.workspaceId],
    references: [workspaces.id],
  }),
}));

export const runtimeProfilesRelations = relations(runtimeProfiles, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [runtimeProfiles.workspaceId],
    references: [workspaces.id],
  }),
  agents: many(agents),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agents.workspaceId],
    references: [workspaces.id],
  }),
  runtimeProfile: one(runtimeProfiles, {
    fields: [agents.workspaceId, agents.runtimeProfileId],
    references: [runtimeProfiles.workspaceId, runtimeProfiles.id],
  }),
  policy: one(agentPolicies),
  sessions: many(sessions),
  tasks: many(tasks),
  events: many(events),
  ledgerDays: many(ledgerDaily),
  receipts: many(precheckReceipts),
  blocks: many(blocks),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  agent: one(agents, {
    fields: [sessions.workspaceId, sessions.agentId],
    references: [agents.workspaceId, agents.id],
  }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  session: one(sessions, {
    fields: [tasks.workspaceId, tasks.sessionId],
    references: [sessions.workspaceId, sessions.id],
  }),
  agent: one(agents, {
    fields: [tasks.workspaceId, tasks.agentId],
    references: [agents.workspaceId, agents.id],
  }),
}));

export const workspacePolicyStateRelations = relations(workspacePolicyState, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspacePolicyState.workspaceId],
    references: [workspaces.id],
  }),
}));

export const agentPoliciesRelations = relations(agentPolicies, ({ one }) => ({
  agent: one(agents, {
    fields: [agentPolicies.workspaceId, agentPolicies.agentId],
    references: [agents.workspaceId, agents.id],
  }),
}));

export const ledgerDailyRelations = relations(ledgerDaily, ({ one }) => ({
  agent: one(agents, {
    fields: [ledgerDaily.workspaceId, ledgerDaily.agentId],
    references: [agents.workspaceId, agents.id],
  }),
}));

export const precheckReceiptsRelations = relations(precheckReceipts, ({ one, many }) => ({
  agent: one(agents, {
    fields: [precheckReceipts.workspaceId, precheckReceipts.agentId],
    references: [agents.workspaceId, agents.id],
  }),
  // A plane-owned denial writes exactly one block referencing this receipt.
  // The foreign key lives on `blocks`; see the note in blocks.ts.
  blocks: many(blocks),
}));

export const blocksRelations = relations(blocks, ({ one, many }) => ({
  agent: one(agents, {
    fields: [blocks.workspaceId, blocks.agentId],
    references: [agents.workspaceId, agents.id],
  }),
  precheckReceipt: one(precheckReceipts, {
    fields: [blocks.workspaceId, blocks.precheckReceiptId],
    references: [precheckReceipts.workspaceId, precheckReceipts.id],
  }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [events.workspaceId],
    references: [workspaces.id],
  }),
  agent: one(agents, {
    fields: [events.workspaceId, events.agentId],
    references: [agents.workspaceId, agents.id],
  }),
  precheckReceipt: one(precheckReceipts, {
    fields: [events.workspaceId, events.precheckReceiptId],
    references: [precheckReceipts.workspaceId, precheckReceipts.id],
  }),
  block: one(blocks, {
    fields: [events.workspaceId, events.blockId],
    references: [blocks.workspaceId, blocks.id],
  }),
}));
