/**
 * Authentication email delivery.
 *
 * The auth service depends on the `AuthEmailSender` interface, never on Resend
 * directly, so the provider is replaceable and tests need no network.
 */

export interface MagicLinkEmail {
  /** Normalised recipient address. */
  readonly to: string;
  /** Fully-formed sign-in URL, including the plaintext token. SENSITIVE. */
  readonly url: string;
}

export interface AuthEmailSender {
  sendMagicLink(email: MagicLinkEmail): Promise<void>;
}

/** Raised when the provider rejects a send. Never carries provider internals. */
export class AuthEmailError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthEmailError';
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface ResendEmailSenderOptions {
  /** SECRET. Sent only in the Authorization header; never logged or returned. */
  readonly apiKey: string;
  /** Verified sender address, e.g. `Platform <auth@example.com>`. */
  readonly from: string;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Production Resend adapter.
 *
 * WHY THE REST API AND NOT THE SDK
 * --------------------------------
 * A single authenticated POST does not justify another dependency and its
 * transitive tree. Node 20 ships global `fetch`, so this is a few lines and
 * keeps the dependency surface minimal. Swapping in the SDK later changes only
 * this function.
 *
 * ERROR HANDLING
 * --------------
 * The provider's response body is never propagated. It can echo request
 * content - including the magic-link URL - and could carry account detail. Only
 * the status code is surfaced.
 */
export function createResendEmailSender(options: ResendEmailSenderOptions): AuthEmailSender {
  const send = options.fetchImpl ?? fetch;

  return {
    async sendMagicLink(email: MagicLinkEmail): Promise<void> {
      let response: Response;
      try {
        response = await send(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [email.to],
            subject: 'Your sign-in link',
            text: buildPlainTextBody(email.url),
          }),
        });
      } catch {
        // The thrown error can embed the request, and the request embeds the
        // token. Nothing from it is reused.
        throw new AuthEmailError('Email provider request failed.');
      }

      if (!response.ok) {
        throw new AuthEmailError(`Email provider rejected the request (${String(response.status)}).`);
      }
    },
  };
}

function buildPlainTextBody(url: string): string {
  return [
    'Use the link below to sign in to the AI Hybrid Multi-Agent Platform.',
    '',
    url,
    '',
    'This link can be used once and expires shortly.',
    'If you did not request it, you can ignore this email.',
  ].join('\n');
}

/** A magic-link email captured in memory. */
export interface CapturedEmail extends MagicLinkEmail {
  readonly sentAt: Date;
}

export interface CapturingEmailSender extends AuthEmailSender {
  readonly sent: readonly CapturedEmail[];
  lastLink(): CapturedEmail | undefined;
  clear(): void;
}

/**
 * In-memory sender for automated tests.
 *
 * Captures the link in-process so a test can complete the flow without a
 * network or a real inbox. It is NOT a "console email provider": nothing is
 * written to stdout, so a bearer token cannot reach CI logs.
 *
 * This is test infrastructure. Wiring it in production is prevented by
 * `resolveEmailSender`, which only ever constructs the Resend adapter outside
 * of tests.
 */
export function createCapturingEmailSender(): CapturingEmailSender {
  const sent: CapturedEmail[] = [];

  return {
    sent,
    sendMagicLink(email: MagicLinkEmail): Promise<void> {
      sent.push({ ...email, sentAt: new Date() });
      return Promise.resolve();
    },
    lastLink(): CapturedEmail | undefined {
      return sent[sent.length - 1];
    },
    clear(): void {
      sent.length = 0;
    },
  };
}
