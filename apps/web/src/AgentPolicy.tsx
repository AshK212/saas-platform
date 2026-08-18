import {
  agentModeSchema,
  normalizePublishCapInput,
  normalizeSpendCapInput,
  type AgentMode,
  type AgentPolicyResponse,
} from '@hybrid/contracts';
import { useEffect, useState, type FormEvent, type JSX } from 'react';

import { fetchAgentPolicy, saveAgentPolicy } from './api';

/**
 * Operator policy editor for one agent.
 *
 * CONFIGURATION, NOT ENFORCEMENT
 * ------------------------------
 * Saving a cap records the operator's intent. Nothing in the system enforces it
 * yet - precheck arrives in a later step. The wording here is therefore
 * deliberately factual ("Daily spend cap: $25") and never reassuring ("spend
 * protection active"), because an operator who believes a cap is live when it
 * is not is worse off than one who knows it is only configured.
 *
 * MONEY IS NEVER A FLOAT
 * ----------------------
 * `25`, `25.00` and `25.000000` all mean the same cap, so the operator is not
 * made to type six decimals. Normalisation is pure string manipulation in
 * `normalizeSpendCapInput` - no `parseFloat`, no `toFixed` - so the value that
 * reaches `numeric(14,6)` is exactly what was typed. Anything unrepresentable
 * is refused rather than silently rounded.
 */

interface AgentPolicyProps {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly agentLabel: string;
  /** False for `member`, which may read policy but not change it. */
  readonly canManage: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; policy: AgentPolicyResponse }
  | { status: 'error'; message: string };

const MODE_LABELS: Record<AgentMode, string> = {
  watch: 'Watch — record activity only',
  budgeted: 'Budgeted — apply the caps below',
  paused: 'Paused — agent should stop acting',
};

export function AgentPolicy({
  workspaceId,
  agentId,
  agentLabel,
  canManage,
}: AgentPolicyProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [mode, setMode] = useState<AgentMode>('watch');
  const [spendCap, setSpendCap] = useState('');
  const [publishCap, setPublishCap] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [savedVersion, setSavedVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const loaded = await fetchAgentPolicy(workspaceId, agentId);
      if (cancelled) {
        return;
      }
      if (loaded === null) {
        setState({ status: 'error', message: 'Could not load this agent policy.' });
        return;
      }
      setMode(loaded.policy.mode);
      // Blank means uncapped, which is exactly what null means on the wire.
      setSpendCap(loaded.policy.daily_spend_cap_usd ?? '');
      setPublishCap(
        loaded.policy.daily_publish_cap === null ? '' : String(loaded.policy.daily_publish_cap),
      );
      setState({ status: 'ready', policy: loaded });
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId]);

  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError('');

    const normalizedSpend = normalizeSpendCapInput(spendCap);
    if (normalizedSpend === undefined) {
      setFormError('Enter a spend cap like 25 or 25.00, or leave it blank for no cap.');
      return;
    }

    const normalizedPublish = normalizePublishCapInput(publishCap);
    if (normalizedPublish === undefined) {
      setFormError('Enter a whole number of publishes, or leave it blank for no cap.');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveAgentPolicy(workspaceId, agentId, {
        mode,
        daily_spend_cap_usd: normalizedSpend,
        daily_publish_cap: normalizedPublish,
      });
      // Reflect exactly what committed, not what was typed.
      setSpendCap(saved.policy.daily_spend_cap_usd ?? '');
      setPublishCap(
        saved.policy.daily_publish_cap === null ? '' : String(saved.policy.daily_publish_cap),
      );
      setMode(saved.policy.mode);
      setSavedVersion(saved.version);
      setState({ status: 'ready', policy: saved });
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  if (state.status === 'loading') {
    return <p className="text-sm text-ink-muted">Loading policy…</p>;
  }

  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-deny">
        {state.message}
      </p>
    );
  }

  return (
    <form
      className="space-y-4 rounded-md border border-line bg-canvas p-4"
      onSubmit={(event) => {
        void onSave(event);
      }}
    >
      <div className="space-y-1">
        <h4 className="text-sm font-medium text-ink">Policy for {agentLabel}</h4>
        <p className="text-xs text-ink-faint">
          These values are recorded and published to the agent. Enforcement arrives in a later
          step.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor={`mode-${agentId}`} className="block text-xs text-ink-muted">
          Mode
        </label>
        <select
          id={`mode-${agentId}`}
          value={mode}
          disabled={!canManage}
          onChange={(event) => {
            const parsed = agentModeSchema.safeParse(event.target.value);
            if (parsed.success) {
              setMode(parsed.data);
            }
          }}
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
        >
          {agentModeSchema.options.map((option) => (
            <option key={option} value={option}>
              {MODE_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor={`spend-${agentId}`} className="block text-xs text-ink-muted">
            Daily spend cap (USD)
          </label>
          <input
            id={`spend-${agentId}`}
            type="text"
            inputMode="decimal"
            value={spendCap}
            disabled={!canManage}
            placeholder="no cap"
            onChange={(event) => {
              setSpendCap(event.target.value);
            }}
            className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor={`publish-${agentId}`} className="block text-xs text-ink-muted">
            Daily publish cap
          </label>
          <input
            id={`publish-${agentId}`}
            type="text"
            inputMode="numeric"
            value={publishCap}
            disabled={!canManage}
            placeholder="no cap"
            onChange={(event) => {
              setPublishCap(event.target.value);
            }}
            className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
          />
        </div>
      </div>

      <p className="text-xs text-ink-faint">Leave a cap blank for no cap. 0 means nothing allowed.</p>

      {canManage ? (
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      ) : (
        <p className="text-xs text-ink-faint">
          Only workspace operators can change agent policy.
        </p>
      )}

      {savedVersion !== null && formError === '' && (
        <p className="text-xs text-ink-muted">Saved. Policy version {savedVersion}.</p>
      )}

      {formError !== '' && (
        <p role="alert" className="text-sm text-deny">
          {formError}
        </p>
      )}
    </form>
  );
}
