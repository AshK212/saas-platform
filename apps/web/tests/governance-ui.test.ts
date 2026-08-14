import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  capsApply,
  describeBlockOwner,
  describePublishes,
  describeRule,
  describeSpend,
  formatUsd,
  MODE_LABEL,
  REASON_LABEL,
  RULE_LABEL,
} from '../src/governance-format';

/**
 * Frontend governance guardrails.
 *
 * The browser is a DISPLAY SURFACE for enforcement state, never a source of
 * it. Two failure modes are worth an automated guard because both produce a
 * page that looks right and lies:
 *
 *   - deriving money or a day in the browser, so the operator sees a number
 *     the plane never enforced against
 *   - claiming protection because a cap exists, when nothing was stopped
 *
 * Half of this file unit-tests the formatting module; the other half scans
 * `apps/web/src` for the patterns that would reintroduce those failures.
 */

const WEB_SRC = path.resolve(import.meta.dirname, '..', 'src');

/** Every frontend source file, with comments stripped. */
function frontendSources(): { file: string; code: string; raw: string }[] {
  const found: { file: string; code: string; raw: string }[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const raw = readFileSync(full, 'utf8');
      found.push({
        file: path.relative(WEB_SRC, full),
        // Prose about a forbidden pattern must not trip the guard for it.
        code: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
        raw,
      });
    }
  };

  walk(WEB_SRC);
  return found;
}

/** The governance display surface specifically. */
function governanceSources(): { file: string; code: string; raw: string }[] {
  return frontendSources().filter(({ file }) =>
    /^(Governance\.tsx|Agents\.tsx|governance-format\.ts)$/.test(file),
  );
}

describe('money is formatted, never computed', () => {
  it('renders a canonical six-decimal amount as two-decimal currency', () => {
    expect(formatUsd('25.000000')).toBe('$25.00');
    expect(formatUsd('24.000000')).toBe('$24.00');
    expect(formatUsd('0.000000')).toBe('$0.00');
    expect(formatUsd('0.500000')).toBe('$0.50');
  });

  it('groups thousands', () => {
    expect(formatUsd('1234.500000')).toBe('$1,234.50');
    expect(formatUsd('1000000.000000')).toBe('$1,000,000.00');
    expect(formatUsd('999.990000')).toBe('$999.99');
  });

  it('handles the storage maximum without loss in the integer part', () => {
    // 99999999.999999 exceeds what a float can represent exactly at six
    // decimals across accumulation. Here it is a string operation, so the
    // integer digits are reproduced verbatim.
    expect(formatUsd('99999999.999999')).toBe('$99,999,999.99');
  });

  it('TRUNCATES rather than rounds the sub-cent remainder', () => {
    // Rounding up would show `$25.00 / $25.00` for a committed 24.999999,
    // reading as a cap reached when the plane still has headroom. Display must
    // never overstate what was spent.
    expect(formatUsd('24.999999')).toBe('$24.99');
    expect(formatUsd('0.009999')).toBe('$0.00');
  });

  it('accepts an amount with no fractional part', () => {
    expect(formatUsd('25')).toBe('$25.00');
    expect(formatUsd('0')).toBe('$0.00');
  });

  it('never round-trips through a number', () => {
    // The proof: a value with more precision than a double can hold is
    // reproduced exactly in its integer digits.
    const exact = '9007199254740993.000000';
    expect(formatUsd(exact)).toContain('9,007,199,254,740,993');
  });
});

describe('usage is reported against its cap without comparing them', () => {
  const budgeted = {
    mode: 'budgeted',
    dailySpendCapUsd: '25.000000',
    dailyPublishCap: 5,
    spendCommittedUsd: '24.000000',
    publishCountCommitted: 4,
    accountingDay: '2026-05-04',
  } as const;

  it('renders the capped forms exactly as specified', () => {
    expect(describeSpend(budgeted)).toBe('$24.00 / $25.00');
    expect(describePublishes(budgeted)).toBe('4 / 5');
  });

  it('renders the uncapped forms', () => {
    expect(describeSpend({ ...budgeted, dailySpendCapUsd: null })).toBe('$24.00 / Uncapped');
    expect(describePublishes({ ...budgeted, dailyPublishCap: null })).toBe('4 / Uncapped');
  });

  it('reports usage at or beyond a cap without editorialising', () => {
    // The plane decides whether the next action is allowed. The display states
    // the two numbers and stops - it does not print "exceeded" or "blocked",
    // because a total equal to a cap is not itself a denial.
    const atCap = { ...budgeted, spendCommittedUsd: '25.000000' };
    expect(describeSpend(atCap)).toBe('$25.00 / $25.00');
    expect(describeSpend(atCap)).not.toMatch(/exceed|over|blocked|stopped/i);
  });

  it('shows zero usage as a computed read, not as absent', () => {
    // No ledger row for today is not "unknown" - it is zero committed. The
    // server sends the zeroes; the display renders them like any other total.
    const fresh = { ...budgeted, spendCommittedUsd: '0.000000', publishCountCommitted: 0 };
    expect(describeSpend(fresh)).toBe('$0.00 / $25.00');
    expect(describePublishes(fresh)).toBe('0 / 5');
  });

  it('shows caps only where they apply', () => {
    // A leftover cap under `watch` governs nothing. Displaying it beside a
    // watching agent would imply a budget is in force.
    expect(capsApply('budgeted')).toBe(true);
    expect(capsApply('watch')).toBe(false);
    expect(capsApply('paused')).toBe(false);
  });
});

describe('vocabulary is complete and honest', () => {
  it('labels every mode', () => {
    expect(Object.keys(MODE_LABEL).sort()).toEqual(['budgeted', 'paused', 'watch']);
  });

  it('labels every deny reason and every plane rule', () => {
    expect(Object.keys(REASON_LABEL).sort()).toEqual([
      'daily_publish_cap_exceeded',
      'daily_spend_cap_exceeded',
      'paused',
    ]);
    expect(Object.keys(RULE_LABEL).sort()).toEqual([
      'agent_paused',
      'daily_publish_cap',
      'daily_spend_cap',
    ]);
  });

  it('shows an unrecognised runtime rule verbatim', () => {
    // A runtime chooses its own rule string. Inventing a friendly label for a
    // value we do not control would misrepresent what the plugin reported.
    expect(describeRule('daily_spend_cap')).toBe('Daily spend cap');
    expect(describeRule('vendor_custom_guard')).toBe('vendor_custom_guard');
    expect(describeRule('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('distinguishes who refused', () => {
    expect(describeBlockOwner('plane')).toBe('Control plane block');
    expect(describeBlockOwner('runtime')).toBe('Runtime-reported block');
  });

  it('no label claims safety or protection', () => {
    const claims = /\b(safe|safely|protected|secure|guaranteed|prevented)\b/i;
    for (const label of [
      ...Object.values(MODE_LABEL),
      ...Object.values(REASON_LABEL),
      ...Object.values(RULE_LABEL),
    ]) {
      expect(label, label).not.toMatch(claims);
    }
  });
});

describe('the browser never derives enforcement state', () => {
  it('NO FLOAT ARITHMETIC ON MONEY ANYWHERE IN THE FRONTEND', () => {
    // A float comparison here could disagree with the exact micro-dollar
    // comparison the precheck actually made, showing an operator a cap as
    // unmet that the plane already refused against.
    const offenders = frontendSources()
      .filter(({ code }) => /\bparseFloat\s*\(|\.toFixed\s*\(|Number\.parseFloat\s*\(/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('the governance surface never coerces a decimal string to a number', () => {
    const offenders = governanceSources()
      .filter(({ code }) =>
        /Number\s*\(\s*\w*(?:[Uu]sd|[Ss]pend|[Cc]ap|[Aa]mount)/.test(code),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('the governance surface never compares committed usage to a cap', () => {
    // "Is this agent over budget?" is a question only the plane answers, and it
    // answers it in the receipt. A `>=` here would be a second, divergent
    // enforcement engine running in the browser.
    const offenders = governanceSources()
      .filter(({ code }) =>
        /(?:spendCommittedUsd|publishCountCommitted)\s*(?:>=?|<=?)|(?:>=?|<=?)\s*(?:governance\.)?daily(?:Spend|Publish)Cap/.test(
          code,
        ),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('NO BROWSER-LOCAL DAY IS DERIVED', () => {
    // The accounting day arrives on the response. A browser in UTC+13 deriving
    // its own "today" would show tomorrow's empty ledger beside today's caps.
    const offenders = governanceSources()
      .filter(({ code }) =>
        /getFullYear|getMonth|getDate\s*\(|toLocaleDateString|toISOString\s*\(\s*\)\s*\.slice|Intl\.DateTimeFormat/.test(
          code,
        ),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('the governance surface reads its day from the server response', () => {
    const agents = governanceSources().find(({ file }) => file === 'Agents.tsx');
    expect(agents).toBeDefined();
    // Rendered from the payload, and labelled UTC so the boundary is legible.
    expect(agents?.code).toContain('governance.accountingDay');
    expect(agents?.code).toContain('(UTC)');
  });
});

describe('the governance surface is read-only', () => {
  it('sends no mutating request to a receipt or block route', () => {
    // Scoped to individual FUNCTIONS, not whole files: `api.ts` legitimately
    // posts to workspace, credential and policy routes, so a file-level check
    // would flag it forever and stop meaning anything.
    const offenders: string[] = [];

    for (const { file, code } of frontendSources()) {
      // Each chunk is one exported function body (the first is the imports).
      const chunks = code.split(/export async function /);
      for (const chunk of chunks.slice(1)) {
        const name = /^(\w+)/.exec(chunk)?.[1] ?? 'anonymous';
        if (!/workspaceReceipt|workspaceBlock/.test(chunk)) continue;
        if (/method\s*:\s*'(?:POST|PUT|PATCH|DELETE)'/.test(chunk)) {
          offenders.push(`${file}:${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('every governance fetch is a plain GET', () => {
    // Guards the guard above: it only fires on an explicit `method`, so this
    // asserts the four governance calls exist and none of them sets one.
    const api = frontendSources().find(({ file }) => file === 'api.ts');
    expect(api).toBeDefined();

    const governanceFns = api?.code
      .split(/export async function /)
      .slice(1)
      .filter((chunk) => /workspaceReceipt|workspaceBlock/.test(chunk));

    expect(governanceFns?.map((chunk) => /^(\w+)/.exec(chunk)?.[1]).sort()).toEqual([
      'fetchBlock',
      'fetchBlocks',
      'fetchReceipt',
      'fetchReceipts',
    ]);
    for (const chunk of governanceFns ?? []) {
      expect(chunk).not.toContain('method:');
      // Session cookie, never an API key: these routes are operator-only.
      expect(chunk).toContain("credentials: 'include'");
    }
  });

  it('offers no acknowledge, dismiss, override or export control', () => {
    const governance = governanceSources().find(({ file }) => file === 'Governance.tsx');
    expect(governance).toBeDefined();

    // A control that appeared to change the record would misrepresent the
    // audit trail even though the server has no route to accept it.
    for (const forbidden of ['Acknowledge', 'Dismiss', 'Override', 'Export', 'Download', 'Delete']) {
      expect(governance?.code, forbidden).not.toContain(forbidden);
    }
  });

  it('NO dangerouslySetInnerHTML ANYWHERE IN THE FRONTEND', () => {
    // Receipt and block text includes runtime-authored free text. Every value
    // is a React text child, so it is escaped.
    const offenders = frontendSources()
      .filter(({ code }) => code.includes('dangerouslySetInnerHTML'))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('builds no HTML from governance data', () => {
    const offenders = governanceSources()
      .filter(({ code }) => /innerHTML|document\.write|insertAdjacentHTML/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe('the receipt view presents historical evidence as historical', () => {
  it('labels the applied policy as of decision time', () => {
    const governance = governanceSources().find(({ file }) => file === 'Governance.tsx');
    // Without this wording, an operator reading a denial after raising a cap
    // would reasonably assume the caps shown are the ones in force now.
    expect(governance?.raw).toContain('at decision time');
    expect(governance?.raw).toContain('Current policy may differ');
  });

  it('renders applied policy fields, not current policy fields', () => {
    const governance = governanceSources().find(({ file }) => file === 'Governance.tsx');
    for (const field of ['appliedMode', 'appliedSpendCapUsd', 'appliedPublishCap']) {
      expect(governance?.code, field).toContain(`detail.${field}`);
    }
    // The live fleet state has no business inside a historical receipt panel.
    expect(governance?.code).not.toContain('detail.governance');
  });

  it('states plainly that a runtime block carries no plane decision', () => {
    const governance = governanceSources().find(({ file }) => file === 'Governance.tsx');
    // Fabricating a receipt for a refusal the plane never made would be a lie
    // about who enforced what.
    expect(governance?.code).toContain('The control plane made no decision for this block.');
  });

  it('claims nothing about protection merely because a cap is configured', () => {
    const claims =
      /\b(you are (?:safe|protected)|fully protected|guaranteed|will be blocked|is protected|kept safe)\b/i;
    for (const { file, raw } of governanceSources()) {
      expect(raw, file).not.toMatch(claims);
    }
  });
});
