import {
  agentListResponseSchema,
  apiKeyListResponseSchema,
  AUTH_LOGOUT_PATH,
  AUTH_MAGIC_LINK_PATH,
  AUTH_ME_PATH,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  createWorkspaceRequestSchema,
  revokeApiKeyPath,
  revokeApiKeyResponseSchema,
  workspaceAgentsPath,
  workspaceApiKeysPath,
  type AgentSummary,
  type ApiKeySummary,
  type IssuedApiKey,
  agentPolicyMutationRequestSchema,
  agentPolicyPath,
  agentPolicyResponseSchema,
  blockDetailResponseSchema,
  blockListResponseSchema,
  receiptDetailResponseSchema,
  receiptListResponseSchema,
  workspaceBlockPath,
  workspaceBlocksPath,
  workspaceReceiptPath,
  workspaceReceiptsPath,
  workspaceShareLinksPath,
  workspaceDemoPath,
  demoAgentListResponseSchema,
  demoAgentsPath,
  demoBlockListResponseSchema,
  demoBlocksPath,
  demoEventDetailResponseSchema,
  demoEventListResponseSchema,
  demoEventPath,
  demoEventsPath,
  demoReceiptListResponseSchema,
  demoReceiptsPath,
  demoSettingsResponseSchema,
  demoWorkspacePath,
  demoWorkspaceResponseSchema,
  type DemoAgentListResponse,
  type DemoBlockListResponse,
  type DemoEventListResponse,
  type DemoReceiptListResponse,
  type DemoSettings,
  type DemoWorkspace,
  revokeShareLinkPath,
  shareLinkCreatedResponseSchema,
  shareLinkListResponseSchema,
  SHARE_ACCESS_PATH,
  SHARE_AGENTS_PATH,
  SHARE_BLOCKS_PATH,
  SHARE_EVENTS_PATH,
  SHARE_RECEIPTS_PATH,
  shareAccessResponseSchema,
  shareAgentListResponseSchema,
  shareBlockListResponseSchema,
  shareEventDetailResponseSchema,
  shareEventListResponseSchema,
  shareEventPath,
  shareReceiptListResponseSchema,
  type ShareAccessResponse,
  type ShareAgentListResponse,
  type ShareBlockListResponse,
  type ShareEventListResponse,
  type ShareLinkCreatedResponse,
  type ShareLinkSummary,
  type ShareReceiptListResponse,
  type BlockDetail,
  type BlockListResponse,
  type ReceiptDetail,
  type ReceiptListResponse,
  currentUserResponseSchema,
  eventDetailResponseSchema,
  type AgentPolicyMutationRequest,
  type AgentPolicyResponse,
  magicLinkRequestSchema,
  magicLinkResponseSchema,
  TIMELINE_AGENT_PARAM,
  TIMELINE_CURSOR_PARAM,
  timelineResponseSchema,
  workspaceEventPath,
  workspaceEventsPath,
  type EventDetail,
  type TimelineResponse,
  workspaceListResponseSchema,
  workspacePath,
  workspaceResponseSchema,
  WORKSPACES_PATH,
  type CurrentUserResponse,
  type WorkspaceSummary,
} from '@hybrid/contracts';

/**
 * Browser API client.
 *
 * `credentials: 'include'` is required so the HttpOnly session cookie is sent.
 * The browser never reads that cookie - it cannot, by design - so there is no
 * token handling in this file and nothing is written to localStorage or
 * sessionStorage.
 *
 * Requests go to a same-origin path. In development the Vite dev server proxies
 * `/v1/*` to the API, so the browser sees one origin and SameSite=Lax cookies
 * work without any CORS involvement.
 */

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Requests a sign-in link. Resolves the same way for any valid address. */
export async function requestMagicLink(email: string): Promise<void> {
  const parsed = magicLinkRequestSchema.safeParse({ email });
  if (!parsed.success) {
    throw new Error('Enter a valid email address.');
  }

  const response = await postJson(AUTH_MAGIC_LINK_PATH, parsed.data);
  if (!response.ok) {
    throw new Error('Could not send the sign-in link. Please try again.');
  }

  const body: unknown = await response.json();
  if (!magicLinkResponseSchema.safeParse(body).success) {
    throw new Error('Unexpected response from the server.');
  }
}

/** Returns the signed-in identity, or null when not authenticated. */
export async function fetchCurrentUser(): Promise<CurrentUserResponse['user'] | null> {
  const response = await fetch(AUTH_ME_PATH, { credentials: 'include' });
  if (!response.ok) {
    return null;
  }

  const parsed = currentUserResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.user : null;
}

/** Signs out. The server revokes the session; the cookie is cleared by it. */
export async function logout(): Promise<void> {
  await fetch(AUTH_LOGOUT_PATH, { method: 'POST', credentials: 'include' });
}

/**
 * Lists the workspaces the signed-in user belongs to.
 *
 * The server derives this from membership; the browser sends no workspace id
 * and could not influence the result if it tried.
 */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const response = await fetch(WORKSPACES_PATH, { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Could not load your workspaces.');
  }

  const parsed = workspaceListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.workspaces;
}

/** Creates a workspace; the caller becomes its first operator member. */
export async function createWorkspace(name: string): Promise<WorkspaceSummary> {
  const parsedRequest = createWorkspaceRequestSchema.safeParse({ name });
  if (!parsedRequest.success) {
    throw new Error('Enter a workspace name.');
  }

  const response = await postJson(WORKSPACES_PATH, parsedRequest.data);
  if (!response.ok) {
    throw new Error('Could not create the workspace.');
  }

  const parsed = workspaceResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.workspace;
}

/**
 * Lists a workspace's agents, most recently seen first.
 *
 * Read-only: the browser never registers agents. Registration is a machine
 * operation authenticated with an API key.
 */
export async function listAgents(workspaceId: string): Promise<AgentSummary[]> {
  const response = await fetch(workspaceAgentsPath(workspaceId), { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Could not load agents.');
  }

  const parsed = agentListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.agents;
}

/**
 * Fetches one page of the workspace event timeline (AC-05).
 *
 * FILTERING HAPPENS ON THE SERVER. The agent id is sent as a query parameter
 * and resolved inside the authorized workspace. Fetching every event and
 * filtering in the browser would not scale, would leak nothing but would show
 * the operator a partial page as though it were complete, and would defeat the
 * bounded-page design entirely.
 */
export async function fetchTimeline(
  workspaceId: string,
  options: { agentId?: string | undefined; cursor?: string | undefined } = {},
): Promise<TimelineResponse> {
  const params = new URLSearchParams();
  if (options.agentId !== undefined && options.agentId !== '') {
    params.set(TIMELINE_AGENT_PARAM, options.agentId);
  }
  if (options.cursor !== undefined && options.cursor !== '') {
    params.set(TIMELINE_CURSOR_PARAM, options.cursor);
  }

  const query = params.toString();
  const path = `${workspaceEventsPath(workspaceId)}${query === '' ? '' : `?${query}`}`;

  const response = await fetch(path, { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Could not load events.');
  }

  const parsed = timelineResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data;
}

/**
 * Fetches one event including its raw validated payload (AC-06).
 *
 * `eventId` is the INTERNAL uuid carried by timeline rows, not the
 * client-supplied `event_id`.
 */
export async function fetchEventDetail(
  workspaceId: string,
  eventId: string,
): Promise<EventDetail> {
  const response = await fetch(workspaceEventPath(workspaceId, eventId), {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Could not load that event.');
  }

  const parsed = eventDetailResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.event;
}

/**
 * Reads one agent's EFFECTIVE policy, for populating the editor.
 *
 * Effective, not stored: an agent that has never been configured reports the
 * default (`watch`, uncapped) rather than an empty form the operator might
 * read as "no policy applies".
 */
export async function fetchAgentPolicy(
  workspaceId: string,
  agentId: string,
): Promise<AgentPolicyResponse | null> {
  const response = await fetch(agentPolicyPath(workspaceId, agentId), {
    credentials: 'include',
  });
  if (!response.ok) {
    return null;
  }

  const parsed = agentPolicyResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/**
 * Saves one agent's complete policy.
 *
 * PUT with the whole object: the server replaces all three fields, so clearing
 * a cap actually clears it. The response carries the committed workspace policy
 * version, which agents pick up on their next poll.
 */
export async function saveAgentPolicy(
  workspaceId: string,
  agentId: string,
  policy: AgentPolicyMutationRequest,
): Promise<AgentPolicyResponse> {
  // Validated client-side too, so an impossible request never leaves the
  // browser and the operator sees the problem immediately.
  const parsedRequest = agentPolicyMutationRequestSchema.safeParse(policy);
  if (!parsedRequest.success) {
    throw new Error('That policy is not valid.');
  }

  const response = await fetch(agentPolicyPath(workspaceId, agentId), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsedRequest.data),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? 'Only workspace operators can change agent policy.'
        : 'Could not save the policy.',
    );
  }

  const parsed = agentPolicyResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data;
}

/**
 * Lists governance decisions, newest first.
 *
 * Filtering happens on the SERVER; the browser sends an external agent id and
 * a decision, never an internal UUID and never a raw query.
 */
export async function fetchReceipts(
  workspaceId: string,
  options: { agentId?: string; decision?: 'allow' | 'deny'; cursor?: string } = {},
): Promise<ReceiptListResponse> {
  const params = new URLSearchParams();
  if (options.agentId !== undefined && options.agentId !== '') {
    params.set('agent_id', options.agentId);
  }
  if (options.decision !== undefined) {
    params.set('decision', options.decision);
  }
  if (options.cursor !== undefined && options.cursor !== '') {
    params.set('cursor', options.cursor);
  }

  const query = params.toString();
  const response = await fetch(
    `${workspaceReceiptsPath(workspaceId)}${query === '' ? '' : `?${query}`}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error('Could not load decisions.');
  }

  const parsed = receiptListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data;
}

/**
 * Fetches one decision's full evidence.
 *
 * Everything returned was persisted at decision time; nothing is recomputed
 * against current policy.
 */
export async function fetchReceipt(
  workspaceId: string,
  receiptId: string,
): Promise<ReceiptDetail | null> {
  const response = await fetch(workspaceReceiptPath(workspaceId, receiptId), {
    credentials: 'include',
  });
  if (!response.ok) {
    return null;
  }
  const parsed = receiptDetailResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.receipt : null;
}

/** Lists blocks, runtime- and plane-owned alike, newest first. */
export async function fetchBlocks(
  workspaceId: string,
  options: { agentId?: string; source?: 'plane' | 'runtime'; cursor?: string } = {},
): Promise<BlockListResponse> {
  const params = new URLSearchParams();
  if (options.agentId !== undefined && options.agentId !== '') {
    params.set('agent_id', options.agentId);
  }
  if (options.source !== undefined) {
    params.set('source', options.source);
  }
  if (options.cursor !== undefined && options.cursor !== '') {
    params.set('cursor', options.cursor);
  }

  const query = params.toString();
  const response = await fetch(
    `${workspaceBlocksPath(workspaceId)}${query === '' ? '' : `?${query}`}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error('Could not load blocks.');
  }

  const parsed = blockListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data;
}

/** Fetches one block, including the quantity it refused. */
export async function fetchBlock(
  workspaceId: string,
  blockId: string,
): Promise<BlockDetail | null> {
  const response = await fetch(workspaceBlockPath(workspaceId, blockId), {
    credentials: 'include',
  });
  if (!response.ok) {
    return null;
  }
  const parsed = blockDetailResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.block : null;
}

/** Lists a workspace's API credentials. Safe metadata only - never a key. */
export async function listApiKeys(workspaceId: string): Promise<ApiKeySummary[]> {
  const response = await fetch(workspaceApiKeysPath(workspaceId), { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Could not load API keys.');
  }

  const parsed = apiKeyListResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.apiKeys;
}

/**
 * Issues an API key.
 *
 * SHOW-ONCE: the returned `key` is the only time plaintext will ever exist on
 * the client. It is handed straight to transient React state and deliberately
 * never written to localStorage, sessionStorage or IndexedDB.
 */
export async function createApiKey(workspaceId: string, name: string): Promise<IssuedApiKey> {
  const parsedRequest = createApiKeyRequestSchema.safeParse({ name });
  if (!parsedRequest.success) {
    throw new Error('Enter a name for the key.');
  }

  const response = await postJson(workspaceApiKeysPath(workspaceId), parsedRequest.data);
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? 'Only workspace operators can create API keys.'
        : 'Could not create the API key.',
    );
  }

  const parsed = createApiKeyResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.apiKey;
}

/** Revokes a key. The server invalidates it immediately; no key is returned. */
export async function revokeApiKey(
  workspaceId: string,
  credentialId: string,
): Promise<ApiKeySummary> {
  const response = await postJson(revokeApiKeyPath(workspaceId, credentialId), {});
  if (!response.ok) {
    throw new Error('Could not revoke the API key.');
  }

  const parsed = revokeApiKeyResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.apiKey;
}

/**
 * Opens one workspace.
 *
 * The id is a lookup argument. The server re-proves membership on every call,
 * so a stored selection grants nothing on its own.
 */
export async function openWorkspace(workspaceId: string): Promise<WorkspaceSummary | null> {
  const response = await fetch(workspacePath(workspaceId), { credentials: 'include' });
  if (!response.ok) {
    // 404 covers both "no such workspace" and "not yours" - the client cannot
    // and should not distinguish them.
    return null;
  }

  const parsed = workspaceResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.workspace : null;
}

// ─── Read-only workspace sharing (AC-18) ────────────────────────────────────

/**
 * Issues a share link. OPERATOR ONLY.
 *
 * The plaintext token in the response is the ONLY copy that will ever exist -
 * the server kept a digest. It is returned to the caller and never written to
 * localStorage, sessionStorage or any other persistent store.
 */
export async function createShareLink(workspaceId: string): Promise<ShareLinkCreatedResponse> {
  const response = await fetch(workspaceShareLinksPath(workspaceId), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? 'Only an operator can create a share link.'
        : 'Could not create the share link.',
    );
  }

  const parsed = shareLinkCreatedResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data;
}

/** Lists share links. Metadata only - no token is recoverable. */
export async function listShareLinks(workspaceId: string): Promise<ShareLinkSummary[]> {
  const response = await fetch(workspaceShareLinksPath(workspaceId), {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error('Could not load share links.');
  }
  const parsed = shareLinkListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.shareLinks : [];
}

/** Revokes a share link. Idempotent. */
export async function revokeShareLink(
  workspaceId: string,
  shareId: string,
): Promise<ShareLinkSummary | null> {
  const response = await fetch(revokeShareLinkPath(workspaceId, shareId), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error('Could not revoke the share link.');
  }
  const parsed = shareLinkListResponseSchema.safeParse(await response.json());
  return parsed.success ? (parsed.data.shareLinks[0] ?? null) : null;
}

// ─── The public shared view ─────────────────────────────────────────────────

/**
 * Exchanges a share token for a viewing cookie.
 *
 * The token is POSTed in a BODY and then forgotten by this module. It is never
 * kept in component state beyond this call, never written to any browser
 * storage, and never appended to a later request - the HttpOnly cookie the
 * server sets carries the session from here on.
 */
export async function openShare(token: string): Promise<ShareAccessResponse | null> {
  const response = await fetch(SHARE_ACCESS_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    return null;
  }
  const parsed = shareAccessResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/** The shared fleet. Null means the link is dead - revoked, or never valid. */
export async function fetchSharedAgents(): Promise<ShareAgentListResponse | null> {
  const response = await fetch(SHARE_AGENTS_PATH, { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = shareAgentListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/** The shared timeline. */
export async function fetchSharedEvents(
  cursor?: string,
): Promise<ShareEventListResponse | null> {
  const query = cursor === undefined || cursor === '' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await fetch(`${SHARE_EVENTS_PATH}${query}`, { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = shareEventListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/** One shared event, with its validated raw payload. */
export async function fetchSharedEvent(eventId: string): Promise<EventDetail | null> {
  const response = await fetch(shareEventPath(eventId), { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = shareEventDetailResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.event : null;
}

/** Shared governance decisions. */
export async function fetchSharedReceipts(): Promise<ShareReceiptListResponse | null> {
  const response = await fetch(SHARE_RECEIPTS_PATH, { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = shareReceiptListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

/** Shared blocks. */
export async function fetchSharedBlocks(): Promise<ShareBlockListResponse | null> {
  const response = await fetch(SHARE_BLOCKS_PATH, { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = shareBlockListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

// ─── Public demo mode (AC-19) ───────────────────────────────────────────────

/** Reads this workspace's demo state. OPERATOR ONLY. */
export async function fetchDemoSettings(workspaceId: string): Promise<DemoSettings | null> {
  const response = await fetch(workspaceDemoPath(workspaceId), { credentials: 'include' });
  if (!response.ok) {
    return null;
  }
  const parsed = demoSettingsResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.demo : null;
}

/**
 * Publishes or withdraws the public demo. OPERATOR ONLY.
 *
 * Disabling clears the slug, so re-enabling mints a new one and every
 * previously-published URL stays dead.
 */
export async function setDemoEnabled(
  workspaceId: string,
  enabled: boolean,
): Promise<DemoSettings> {
  const response = await fetch(workspaceDemoPath(workspaceId), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? 'Only an operator can change public demo mode.'
        : 'Could not change public demo mode.',
    );
  }
  const parsed = demoSettingsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Unexpected response from the server.');
  }
  return parsed.data.demo;
}

/**
 * The public demo reads.
 *
 * Every one takes the slug from the URL and NO credential - no cookie, no
 * token, no key. `null` means the demo is unavailable: unknown, malformed or
 * turned off, deliberately indistinguishable.
 */
export async function fetchDemoWorkspace(slug: string): Promise<DemoWorkspace | null> {
  const response = await fetch(demoWorkspacePath(slug));
  if (!response.ok) return null;
  const parsed = demoWorkspaceResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.workspace : null;
}

export async function fetchDemoAgents(slug: string): Promise<DemoAgentListResponse | null> {
  const response = await fetch(demoAgentsPath(slug));
  if (!response.ok) return null;
  const parsed = demoAgentListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

export async function fetchDemoEvents(slug: string): Promise<DemoEventListResponse | null> {
  const response = await fetch(demoEventsPath(slug));
  if (!response.ok) return null;
  const parsed = demoEventListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

export async function fetchDemoEvent(slug: string, eventId: string): Promise<EventDetail | null> {
  const response = await fetch(demoEventPath(slug, eventId));
  if (!response.ok) return null;
  const parsed = demoEventDetailResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.event : null;
}

export async function fetchDemoReceipts(slug: string): Promise<DemoReceiptListResponse | null> {
  const response = await fetch(demoReceiptsPath(slug));
  if (!response.ok) return null;
  const parsed = demoReceiptListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

export async function fetchDemoBlocks(slug: string): Promise<DemoBlockListResponse | null> {
  const response = await fetch(demoBlocksPath(slug));
  if (!response.ok) return null;
  const parsed = demoBlockListResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}
