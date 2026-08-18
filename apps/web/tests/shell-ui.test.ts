import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards for the application shell.
 *
 * The redesign moved the product from one scrolling column to a navigated
 * shell. Two classes of regression become easy at that point, and neither is
 * visible in a screenshot:
 *
 *   1. A navigation entry that leads nowhere. Sidebars attract aspirational
 *      links - Billing, Reports, Integrations - and one that opens a
 *      placeholder teaches an operator to distrust the whole menu.
 *   2. Development vocabulary leaking into the product. Step numbers and
 *      acceptance-criterion labels were on screen until this pass; they are
 *      the kind of thing that creeps back in a hurry.
 */

const WEB_SRC = path.resolve(import.meta.dirname, '..', 'src');

const read = (file: string): string => readFileSync(path.join(WEB_SRC, file), 'utf8');

/** Every frontend source file, with comments stripped. */
function renderedSources(): { file: string; code: string }[] {
  return readdirSync(WEB_SRC)
    .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
    .map((file) => ({
      file,
      code: readFileSync(path.join(WEB_SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }));
}

describe('the product does not expose how it was built', () => {
  it.each([
    'Credit Phase',
    'Step 5',
    'Step 6',
    'Step 11',
    'Step 17',
    'intentionally not implemented',
    'Contracts v',
  ])('no screen renders %s', (phrase) => {
    const offenders = renderedSources()
      .filter(({ code }) => code.includes(phrase))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('renders no acceptance-criterion label', () => {
    // AC references are welcome in comments - they are how a reviewer traces a
    // surface back to its requirement - but never in rendered copy.
    const offenders = renderedSources()
      .filter(({ code }) => /AC-\d{2}/.test(code))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('does not lecture the operator about the authorization model', () => {
    // True, and addressed to a reviewer rather than to someone choosing where
    // to work. The BEHAVIOUR it described is unchanged and still enforced
    // server-side on every request.
    const offenders = renderedSources()
      .filter(({ code }) => code.includes('authorizes no workspace'))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});

describe('navigation offers only destinations that exist', () => {
  const shell = read('AppShell.tsx');

  it('every navigation key is rendered by the workspace application', () => {
    const app = read('WorkspaceApp.tsx');
    const keys = [...shell.matchAll(/key: '([a-z]+)'/g)].map((match) => match[1] ?? '');

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      // Each key must appear in a render branch, so no entry can lead nowhere.
      expect(app, `nav key ${key} has no page`).toContain(`resolved === '${key}'`);
    }
  });

  it('offers no destination the product does not have', () => {
    // Comment-stripped: the shell's own comment NAMES these as deliberately
    // absent, and a raw search would flag the explanation as the violation -
    // pushing the next author to delete the reasoning rather than keep it.
    const code = renderedSources().find((entry) => entry.file === 'AppShell.tsx')?.code ?? '';

    for (const absent of [
      'Billing',
      'Upgrade',
      'Subscription',
      'Integrations',
      'Alerts',
      'Reports',
      'Notifications',
      'Help center',
    ]) {
      expect(code, absent).not.toContain(absent);
    }
  });

  it('OFFERS NO "ADD AGENT" CONTROL', () => {
    // Agents are discovered: a runtime registers itself through the machine API
    // with a workspace key. There is no operator-side create flow, and a button
    // implying one would promise a capability that does not exist.
    for (const { file, code } of renderedSources()) {
      expect(code, file).not.toMatch(/Add agent|New agent|Create agent|Register agent/i);
    }
  });

  it('hides operator-only destinations from a member', () => {
    expect(shell).toContain('operatorOnly');
    expect(shell).toContain("item.operatorOnly !== true || isOperator");
  });
});

describe('the shell stays accessible', () => {
  const shell = read('AppShell.tsx');

  it('marks the active destination with aria-current, not colour alone', () => {
    expect(shell).toContain("aria-current={selected ? 'page' : undefined}");
  });

  it('offers a skip link to the main content', () => {
    expect(shell).toContain('Skip to content');
    expect(shell).toContain('id="main"');
  });

  it('labels the workspace switcher', () => {
    expect(shell).toContain('htmlFor="workspace-switcher"');
    expect(shell).toContain('id="workspace-switcher"');
  });

  it('keeps navigation reachable when the sidebar is hidden', () => {
    // The sidebar is desktop-only; a narrow viewport must not lose navigation
    // altogether, so a horizontal nav takes over rather than disappearing.
    expect(shell).toContain('lg:hidden');
    expect(shell).toContain('lg:flex');
  });

  it('never removes a focus outline', () => {
    const offenders = renderedSources()
      .filter(({ code }) => /outline-none/.test(code) && !/focus:border/.test(code))
      .map(({ file }) => file);

    // `outline-none` is acceptable only where a visible focus treatment
    // replaces it on the same element.
    expect(offenders).toEqual([]);
  });
});

describe('the overview reports counts, never derived money', () => {
  const overview = read('Overview.tsx');

  it('sums nothing', () => {
    // A workspace-level spend total would mean parsing exact decimal strings
    // into floats. The API exposes no such total, and an approximate one could
    // contradict a receipt shown two clicks away.
    for (const forbidden of ['.reduce(', 'parseFloat', '.toFixed(', 'parseInt(']) {
      expect(overview, forbidden).not.toContain(forbidden);
    }
  });

  it('renders per-agent spend through the shared formatter', () => {
    expect(overview).toContain('describeSpend(agent.governance)');
  });

  it('compares no usage against a cap', () => {
    expect(overview).not.toMatch(/spendCommittedUsd\s*[<>]|dailySpendCap\s*[<>]/);
  });
});
