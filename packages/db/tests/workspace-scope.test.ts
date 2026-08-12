import { describe, expect, it } from 'vitest';

import {
  createWorkspaceScope,
  isSameWorkspace,
  WorkspaceScopeError,
} from '../src/repositories/workspace-scope';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('createWorkspaceScope', () => {
  it('creates a scope carrying exactly one workspace id', () => {
    const scope = createWorkspaceScope(WORKSPACE_A);

    expect(scope.workspaceId).toBe(WORKSPACE_A);
  });

  it('carries nothing beyond the workspace id', () => {
    // A scope must not accumulate permissions, users, credentials or request
    // state; it asserts tenancy and nothing else.
    const scope = createWorkspaceScope(WORKSPACE_A);

    expect(Object.keys(scope)).toEqual(['workspaceId']);
  });

  it.each([
    ['an empty string', ''],
    ['a non-uuid string', 'workspace-1'],
    ['a sql fragment', "' OR 1=1 --"],
    ['a truncated uuid', '11111111-1111-4111-8111'],
    ['a uuid with trailing content', `${WORKSPACE_A} OR 1=1`],
  ])('rejects %s', (_label, value) => {
    expect(() => createWorkspaceScope(value)).toThrow(WorkspaceScopeError);
  });

  it('fails closed rather than producing a scope that matches nothing', () => {
    // Silently accepting a bad id would create a scope whose queries return
    // empty results, which reads as "no data" instead of "broken".
    expect(() => createWorkspaceScope('not-a-uuid')).toThrow(/must be a UUID/);
  });
});

describe('isSameWorkspace', () => {
  it('distinguishes two workspaces', () => {
    expect(
      isSameWorkspace(createWorkspaceScope(WORKSPACE_A), createWorkspaceScope(WORKSPACE_B)),
    ).toBe(false);
  });

  it('recognises the same workspace across separate scope instances', () => {
    expect(
      isSameWorkspace(createWorkspaceScope(WORKSPACE_A), createWorkspaceScope(WORKSPACE_A)),
    ).toBe(true);
  });
});

describe('no ambient tenant state', () => {
  it('keeps concurrent scopes independent', async () => {
    // Two scopes used concurrently must not interfere. This is why scope is an
    // argument rather than module-level or AsyncLocalStorage state.
    const [a, b] = await Promise.all([
      Promise.resolve(createWorkspaceScope(WORKSPACE_A)),
      Promise.resolve(createWorkspaceScope(WORKSPACE_B)),
    ]);

    expect(a.workspaceId).toBe(WORKSPACE_A);
    expect(b.workspaceId).toBe(WORKSPACE_B);
  });

  it('exposes no module-level current-workspace accessor', async () => {
    const scopeModule: Record<string, unknown> = await import(
      '../src/repositories/workspace-scope'
    );

    const forbidden = [
      'getCurrentWorkspace',
      'setCurrentWorkspace',
      'currentWorkspace',
      'defaultScope',
      'globalScope',
    ];
    for (const name of forbidden) {
      expect(Object.keys(scopeModule)).not.toContain(name);
    }
  });
});
