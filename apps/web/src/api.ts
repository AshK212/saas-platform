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
  currentUserResponseSchema,
  magicLinkRequestSchema,
  magicLinkResponseSchema,
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
