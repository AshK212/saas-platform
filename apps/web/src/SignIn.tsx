import { useState, type FormEvent, type JSX } from 'react';

import { requestMagicLink } from './api';

type SubmitState = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Magic-link sign-in form.
 *
 * The success message is deliberately neutral - "if an account can be created
 * or found" - because the API answers identically for known and unknown
 * addresses. Saying "we sent you an email" for one case and something else for
 * another would reintroduce the account-existence oracle the API avoids.
 */
export function SignIn(): JSX.Element {
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

  if (state === 'sent') {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-medium">Check your email</h2>
        <p className="max-w-prose text-sm text-slate-300">
          If that address can be signed in, a sign-in link is on its way. The link can be used once
          and expires in 15 minutes.
        </p>
        <button
          type="button"
          className="text-sm text-slate-400 underline underline-offset-4 hover:text-slate-200"
          onClick={() => {
            setState('idle');
          }}
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm text-slate-300">
          Email address
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
          placeholder="you@example.com"
        />
      </div>

      <button
        type="submit"
        disabled={state === 'sending'}
        className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-60"
      >
        {state === 'sending' ? 'Sending…' : 'Send sign-in link'}
      </button>

      {state === 'error' && (
        <p role="alert" className="text-sm text-red-400">
          {message}
        </p>
      )}
    </form>
  );
}
