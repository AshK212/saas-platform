import { describe, expect, it } from 'vitest';

import { loadServerConfig, ServerConfigError } from '../src/server';

/**
 * These tests protect the configuration boundary itself: defaults must be
 * stable, and invalid input must fail loudly rather than silently degrade.
 */
describe('loadServerConfig', () => {
  it('applies documented defaults when the environment is empty', () => {
    const config = loadServerConfig({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.isProduction).toBe(false);
  });

  it('coerces PORT and flags production', () => {
    const config = loadServerConfig({ NODE_ENV: 'production', PORT: '8080' });

    expect(config.port).toBe(8080);
    expect(config.isProduction).toBe(true);
  });

  it('rejects an out-of-range port instead of falling back', () => {
    expect(() => loadServerConfig({ PORT: '70000' })).toThrow(ServerConfigError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadServerConfig({ NODE_ENV: 'staging' })).toThrow(ServerConfigError);
  });
});
