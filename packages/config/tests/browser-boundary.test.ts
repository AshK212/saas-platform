import { afterEach, describe, expect, it } from 'vitest';

import * as browserSafeConfig from '../src/index';
import { loadServerConfig, ServerConfigError } from '../src/server';

/**
 * Guards the server/browser configuration boundary.
 *
 * ESLint blocks `@hybrid/config/server` imports from `apps/web/src/**`, but a
 * lint rule is a build-time control. These tests assert the runtime behaviour
 * that has to hold even if the rule is bypassed.
 */
describe('server/browser configuration boundary', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, 'window', originalWindow);
    }
  });

  it('refuses to load server configuration in a browser context', () => {
    (globalThis as { window?: unknown }).window = { document: {} };

    expect(() => loadServerConfig({})).toThrow(ServerConfigError);
    expect(() => loadServerConfig({})).toThrow(/browser context/);
  });

  it('refuses even when a valid DATABASE_URL is present', () => {
    // The guard must fire before any secret is read, not after.
    (globalThis as { window?: unknown }).window = { document: {} };

    expect(() =>
      loadServerConfig({ DATABASE_URL: 'postgresql://user:secret@host.example.com/db' }),
    ).toThrow(ServerConfigError);
  });

  it('exposes no secret-bearing values from the browser-safe entry point', () => {
    const exported = Object.keys(browserSafeConfig);

    expect(exported).not.toContain('loadServerConfig');
    expect(exported).not.toContain('requireDatabaseUrl');

    const forbidden = /database|secret|password|token|credential|api[_-]?key/i;
    for (const name of exported) {
      expect(name).not.toMatch(forbidden);
    }
  });

  it('browser-safe exports contain no connection-string-shaped values', () => {
    for (const value of Object.values(browserSafeConfig)) {
      if (typeof value === 'string') {
        expect(value).not.toMatch(/postgres(ql)?:\/\//i);
      }
    }
  });
});
