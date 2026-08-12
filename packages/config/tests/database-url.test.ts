import { describe, expect, it } from 'vitest';

import { loadServerConfig, requireDatabaseUrl, ServerConfigError } from '../src/server';

const VALID_URL = 'postgresql://user:secret@ep-example-123.eu-central-1.aws.neon.tech/appdb?sslmode=require';

describe('DATABASE_URL validation', () => {
  it('is optional, so the process can start without a database', () => {
    const config = loadServerConfig({});

    expect(config.databaseUrl).toBeUndefined();
  });

  it('treats an empty value as absent rather than invalid', () => {
    // Render and .env files both surface "not configured" as an empty string.
    expect(loadServerConfig({ DATABASE_URL: '' }).databaseUrl).toBeUndefined();
    expect(loadServerConfig({ DATABASE_URL: '   ' }).databaseUrl).toBeUndefined();
  });

  it('accepts a valid Neon connection URL', () => {
    expect(loadServerConfig({ DATABASE_URL: VALID_URL }).databaseUrl).toBe(VALID_URL);
  });

  it('accepts the postgres:// scheme as well as postgresql://', () => {
    const url = 'postgres://user:secret@db.example.com:5432/appdb';

    expect(loadServerConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it.each([
    ['not a url at all', 'definitely-not-a-url'],
    ['a non-postgres scheme', 'mysql://user:secret@db.example.com/appdb'],
    ['an http url', 'https://example.com/db'],
    ['a url with no host', 'postgresql:///appdb'],
  ])('rejects %s', (_label, value) => {
    expect(() => loadServerConfig({ DATABASE_URL: value })).toThrow(ServerConfigError);
  });

  it('never echoes the connection string in the validation error', () => {
    const secretBearing = 'postgresql-BUT-INVALID://user:hunter2@host/db';

    try {
      loadServerConfig({ DATABASE_URL: secretBearing });
      expect.unreachable('expected validation to fail');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain(secretBearing);
      // It must still say which variable is at fault.
      expect(message).toContain('DATABASE_URL');
    }
  });

  it('applies no fallback value in production', () => {
    // A silent localhost default in production would be a security defect.
    const config = loadServerConfig({ NODE_ENV: 'production' });

    expect(config.isProduction).toBe(true);
    expect(config.databaseUrl).toBeUndefined();
  });
});

describe('requireDatabaseUrl', () => {
  it('returns the URL when configured', () => {
    const config = loadServerConfig({ DATABASE_URL: VALID_URL });

    expect(requireDatabaseUrl(config)).toBe(VALID_URL);
  });

  it('fails loudly and actionably when absent', () => {
    const config = loadServerConfig({});

    expect(() => requireDatabaseUrl(config)).toThrow(ServerConfigError);
    expect(() => requireDatabaseUrl(config)).toThrow(/DATABASE_URL is required/);
  });
});
