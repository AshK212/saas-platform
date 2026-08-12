import { describe, expect, it } from 'vitest';

import { describeConnectionTarget, redactConnectionStrings } from '../src/redact';

const NEON_URL =
  'postgresql://appuser:sup3rs3cret@ep-cool-frost-123456.eu-central-1.aws.neon.tech/appdb?sslmode=require';

describe('redactConnectionStrings', () => {
  it('removes credentials from a Postgres URL', () => {
    const redacted = redactConnectionStrings(`connect failed for ${NEON_URL}`);

    expect(redacted).not.toContain('sup3rs3cret');
    expect(redacted).not.toContain('appuser');
    expect(redacted).toContain('***:***@');
  });

  it('redacts every occurrence, not just the first', () => {
    const redacted = redactConnectionStrings(`${NEON_URL} then ${NEON_URL}`);

    expect(redacted).not.toContain('sup3rs3cret');
    expect(redacted.match(/\*\*\*:\*\*\*@/g)).toHaveLength(2);
  });

  it('handles both postgres:// and postgresql:// schemes', () => {
    const redacted = redactConnectionStrings('postgres://u:p@h/d');

    expect(redacted).toBe('postgres://***:***@h/d');
  });

  it('leaves text without credentials untouched', () => {
    expect(redactConnectionStrings('connection refused')).toBe('connection refused');
  });
});

describe('describeConnectionTarget', () => {
  it('reports host, port and database without credentials', () => {
    const described = describeConnectionTarget(NEON_URL);

    expect(described).toBe('ep-cool-frost-123456.eu-central-1.aws.neon.tech:5432/appdb');
    expect(described).not.toContain('sup3rs3cret');
    expect(described).not.toContain('appuser');
  });

  it('uses an explicit port when present', () => {
    expect(describeConnectionTarget('postgresql://u:p@db.example.com:6543/appdb')).toBe(
      'db.example.com:6543/appdb',
    );
  });

  it('never echoes the input when it cannot be parsed', () => {
    const garbage = 'not-a-url-but-has-a-secret-hunter2';

    const described = describeConnectionTarget(garbage);

    expect(described).toBe('(unparseable connection string)');
    expect(described).not.toContain('hunter2');
  });
});
