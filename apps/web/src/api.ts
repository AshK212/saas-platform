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
