import { useState, type FormEvent, type JSX } from 'react';

import { requestMagicLink } from './api';
import { Button, Card, Field, inputClass } from './ui';

/**
 * Passwordless sign-in.
 *
 * ─── THE RESPONSE IS THE SAME EITHER WAY ──────────────────────────────────
 *
 * "If that address can be signed in, a link is on its way" is careful wording,
 * not vagueness. The server answers identically for a known and an unknown
 * address, so the screen must too - a friendlier "we've emailed you!" for real
 * accounts would turn this form into a way to test whether someone has one.
 */

type SubmitState = 'idle' | 'sending' | 'sent' | 'error';

export function SignIn({ invalidLink = false }: { invalidLink?: boolean }): JSX.Element {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState('sending');
    setMessage('');

    try {
      await requestMagicLink(email);
      setState('sent');
    } catch (error: unknown) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }

  return (
    <main className="min-h-screen bg-canvas">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-16">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center rounded-lg bg-accent text-base font-bold text-white"
          >
            H
          </span>
          <div>
            <p className="text-base font-semibold text-ink">Hybrid Control</p>
            <p className="text-sm text-ink-muted">AI Agent Control Plane</p>
          </div>
        </div>

        {invalidLink && (
          <div role="alert" className="rounded-card border border-line-strong bg-deny-soft px-4 py-3">
            <p className="text-sm font-medium text-deny">That sign-in link is no longer valid</p>
            <p className="mt-0.5 text-sm text-ink-muted">
              Links can be used once and expire after 15 minutes. Request a new one below.
            </p>
          </div>
        )}

        <Card className="p-6">
          {state === 'sent' ? (
            <div className="space-y-3">
              <h1 className="text-lg font-semibold text-ink">Check your email</h1>
              <p className="text-sm text-ink-muted">
                If that address can be signed in, a link is on its way. It can be used once and
                expires in 15 minutes.
              </p>
              <button
                type="button"
                className="text-sm text-accent hover:underline"
                onClick={() => {
                  setState('idle');
                }}
              >
                Use a different address
              </button>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                void onSubmit(event);
              }}
            >
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-ink">Sign in</h1>
                <p className="text-sm text-ink-muted">
                  We will email you a link. There is no password to remember.
                </p>
              </div>

              <Field label="Email address" htmlFor="email">
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  className={inputClass}
                  placeholder="you@example.com"
                />
              </Field>

              <Button type="submit" tone="primary" disabled={state === 'sending'} className="w-full">
                {state === 'sending' ? 'Sending…' : 'Send sign-in link'}
              </Button>

              {state === 'error' && (
                <p role="alert" className="text-sm text-deny">
                  {message}
                </p>
              )}
            </form>
          )}
        </Card>
      </div>
    </main>
  );
}
