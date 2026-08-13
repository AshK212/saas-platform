import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as contracts from '../src/index';

/**
 * Guardrails for the shared contract package itself.
 *
 * `packages/contracts` is consumed by the API, the browser app and (later) the
 * simulator. If a database, server or Node-only dependency leaks in, the
 * browser bundle breaks and the package stops being shareable - so the
 * dependency surface is asserted, not merely intended.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PACKAGE_ROOT, 'src');

function sourceFiles(): string[] {
  return readdirSync(SRC).filter((file) => file.endsWith('.ts'));
}

describe('the contracts package stays dependency-pure', () => {
  it('declares zod as its only dependency', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
  });

  it.each([
    'drizzle-orm',
    'pg',
    'hono',
    '@hybrid/db',
    '@hybrid/config',
    'node:fs',
    'node:crypto',
    'react',
  ])('imports nothing from %s', (forbidden) => {
    for (const file of sourceFiles()) {
      const source = readFileSync(path.join(SRC, file), 'utf8');

      expect(source, `${file} imports ${forbidden}`).not.toMatch(
        new RegExp(`from ['"]${forbidden.replace(/[/@]/g, '\\$&')}`),
      );
    }
  });

  it('imports only zod, or a sibling contract file', () => {
    const importPattern = /from\s+['"]([^'"]+)['"]/g;

    for (const file of sourceFiles()) {
      // Comments are stripped first. The pattern is loose enough that ordinary
      // prose - `indistinguishable from "leave it alone"` - would otherwise
      // read as an import specifier and fail the build on a doc edit.
      const source = readFileSync(path.join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? '';
        const allowed = specifier === 'zod' || specifier.startsWith('./');

        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('is browser-safe: no process, fs or global server APIs', () => {
    for (const file of sourceFiles()) {
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      expect(code, file).not.toMatch(/\bprocess\.env\b|\brequire\(|__dirname/);
    }
  });
});

describe('event contracts are exported from the package root', () => {
  it.each([
    'eventIngestRequestSchema',
    'eventIngestResponseSchema',
    'eventIngestErrorSchema',
    'eventSchema',
    'agentActionEventSchema',
    'spendRecordedEventSchema',
    'actionBlockedEventSchema',
    'heartbeatEventSchema',
    'toValidationIssues',
    'EVENT_INGEST_PATH',
  ])('exports %s', (name) => {
    expect(Object.keys(contracts)).toContain(name);
  });

  it('targets the locked ingest path', () => {
    expect(contracts.EVENT_INGEST_PATH).toBe('/v1/events');
  });
});

describe('event vocabulary agrees with the database enums', () => {
  /**
   * Reads the enum values straight out of the MIGRATED SQL rather than the
   * Drizzle source, so this compares against what a database actually has.
   * Importing @hybrid/db here would violate the purity rule above, so the
   * migration file is parsed as text.
   */
  function enumValuesFromMigration(typeName: string): string[] {
    const migrations = path.resolve(PACKAGE_ROOT, '..', 'db', 'migrations');
    const sql = readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(path.join(migrations, file), 'utf8'))
      .join('\n');

    const match = new RegExp(
      `CREATE TYPE "public"\\."${typeName}" AS ENUM\\(([^)]+)\\)`,
    ).exec(sql);
    if (match === null) {
      throw new Error(`enum ${typeName} not found in migrations`);
    }

    return (match[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
  }

  it('event_type matches exactly', () => {
    // A divergence here would mean valid API input that PostgreSQL rejects.
    expect(contracts.eventTypeSchema.options).toEqual(enumValuesFromMigration('event_type'));
  });

  it('action_category matches exactly', () => {
    expect(contracts.actionCategorySchema.options).toEqual(
      enumValuesFromMigration('action_category'),
    );
  });

  it('agent_mode matches exactly', () => {
    // Step 12 publishes modes on the polling surface. A divergence would mean
    // the API reporting a mode PostgreSQL cannot store, or - worse - Step 13
    // accepting one it cannot persist.
    expect(contracts.agentModeSchema.options).toEqual(enumValuesFromMigration('agent_mode'));
  });

  it('the default mode is a member of the locked vocabulary', () => {
    // `watch` means observe and record, enforce nothing - the only safe
    // default. `budgeted` would apply caps nobody configured and `paused`
    // would halt an agent the operator never chose to stop.
    expect(contracts.agentModeSchema.options).toContain(contracts.DEFAULT_AGENT_MODE);
    expect(contracts.DEFAULT_AGENT_MODE).toBe('watch');
  });
});
