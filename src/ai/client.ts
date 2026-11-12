/**
 * The one place Gaudí talks to Claude.
 *
 * Calls go straight from the browser with the user's own Anthropic API key
 * (kept in localStorage, never sent anywhere else). Every feature asks for
 * structured JSON through `askJson`, which handles the key, streaming,
 * refusals, truncation and error wording in one place.
 */
import type Anthropic from '@anthropic-ai/sdk';

type Sdk = typeof import('@anthropic-ai/sdk').default;

/** The SDK is sizeable and only needed once someone actually uses an AI feature. */
let sdkPromise: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import('@anthropic-ai/sdk').then((m) => m.default);
  return sdkPromise;
}
import { create } from 'zustand';

export const AI_MODEL = 'claude-opus-5-5';
/** Served automatically if the primary model declines a request. */
const FALLBACK_MODEL = 'claude-opus-4-8';

const KEY_STORAGE = 'gaudi-anthropic-key';

export function getApiKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}

export function setApiKey(key: string): void {
  if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim());
  else localStorage.removeItem(KEY_STORAGE);
  useKeyStore.setState({ hasKey: !!key.trim() });
}

interface KeyState {
  hasKey: boolean;
  /** The key dialog is showing. */
  asking: boolean;
  resolve: ((ok: boolean) => void) | null;
}

export const useKeyStore = create<KeyState>(() => ({
  hasKey: !!localStorage.getItem(KEY_STORAGE),
  asking: false,
  resolve: null,
}));

/** True when AI calls can run (a key is saved, or a dev mock is installed). */
export function aiReady(): boolean {
  return !!getApiKey() || hasMock();
}

/**
 * Make sure a key is available, asking for one in a dialog if needed.
 * Resolves false if the user cancels. `force` re-asks even when a key exists.
 */
export function ensureApiKey(force = false): Promise<boolean> {
  if (!force && aiReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    useKeyStore.getState().resolve?.(false);
    useKeyStore.setState({ asking: true, resolve });
  });
}

/** Called by the key dialog. */
export function settleKeyDialog(ok: boolean): void {
  const { resolve } = useKeyStore.getState();
  useKeyStore.setState({ asking: false, resolve: null });
  resolve?.(ok);
}

export type AiErrorKind =
  | 'no-key'
  | 'auth'
  | 'rate'
  | 'refused'
  | 'truncated'
  | 'bad-output'
  | 'aborted'
  | 'network'
  | 'api';

export class AiError extends Error {
  kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}

export type AiContent = string | Anthropic.Beta.BetaContentBlockParam[];

export interface AskOptions {
  /** Short stable name for the call site, e.g. 'furnish', 'generate', 'product-model'. */
  tag: string;
  /** The user turn: a string, or content blocks (text + images). */
  prompt: AiContent;
  system?: string;
  /** JSON Schema for the reply. Objects need `additionalProperties: false` and `required`. */
  schema: Record<string, unknown>;
  /** Default 32000. */
  maxTokens?: number;
  /** Thinking depth / spend. Default 'medium'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  signal?: AbortSignal;
}

declare global {
  interface Window {
    /**
     * Dev/test hook: when set, `askJson` calls this instead of the API and
     * returns whatever it returns (return `undefined` to fall through to the
     * real call). Lets every AI flow run without a key.
     */
    __aiMock?: (tag: string, opts: AskOptions) => unknown | Promise<unknown>;
  }
}

const hasMock = (): boolean => import.meta.env.DEV && typeof window.__aiMock === 'function';

/** Ask Claude for JSON matching `schema`. Throws AiError with a user-readable message. */
export async function askJson<T>(opts: AskOptions): Promise<T> {
  if (hasMock()) {
    const mocked = await window.__aiMock!(opts.tag, opts);
    if (mocked !== undefined) return mocked as T;
  }

  const apiKey = getApiKey();
  if (!apiKey) throw new AiError('no-key', 'Add your Anthropic API key to use AI features.');

  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages
      .stream(
        {
          model: AI_MODEL,
          max_tokens: opts.maxTokens ?? 32000,
          betas: ['server-side-fallback-2026-06-01'],
          fallbacks: [{ model: FALLBACK_MODEL, thinking: { type: 'adaptive' } }],
          output_config: {
            effort: opts.effort ?? 'medium',
            format: { type: 'json_schema', schema: opts.schema },
          },
          ...(opts.system ? { system: opts.system } : {}),
          messages: [{ role: 'user', content: opts.prompt }],
        },
        { signal: opts.signal },
      )
      .finalMessage();
  } catch (e) {
    mapApiError(Anthropic, e);
  }

  if (message.stop_reason === 'refusal') {
    throw new AiError('refused', 'The model declined this request.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiError('truncated', 'The reply was cut off before it finished — try a smaller request.');
  }
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text) throw new AiError('bad-output', 'The model returned an empty reply.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AiError('bad-output', 'The model returned something unreadable — try again.');
  }
}

function mapApiError(Anthropic: Sdk, e: unknown): never {
  if (e instanceof Anthropic.APIUserAbortError) throw new AiError('aborted', 'Cancelled.');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    throw new AiError('auth', 'That API key was not accepted. Check it in Settings.');
  }
  if (e instanceof Anthropic.RateLimitError) {
    throw new AiError('rate', 'Rate limited by the API — wait a moment and try again.');
  }
  if (e instanceof Anthropic.APIConnectionError) {
    throw new AiError('network', 'Could not reach the Anthropic API. Check your connection.');
  }
  if (e instanceof Anthropic.APIError) {
    throw new AiError('api', e.message || `API error ${e.status ?? ''}`.trim());
  }
  throw e;
}

export interface ResearchOptions {
  /** Short stable name for the call site, e.g. 'product-research'. */
  tag: string;
  prompt: string;
  system?: string;
  /** Cap on web searches for this request. Default 4. */
  maxSearches?: number;
  /** Only return results from these domains (e.g. ['amazon.com']). */
  allowedDomains?: string[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Ask Claude a question it may answer by searching the web (Anthropic-hosted
 * web search — nothing is fetched from this browser). Returns plain text; feed
 * it into an `askJson` call if you need structure. The dev mock applies here
 * too: `window.__aiMock(tag, opts)` should return a string.
 */
export async function askWithWebSearch(opts: ResearchOptions): Promise<string> {
  if (hasMock()) {
    const mocked = await window.__aiMock!(opts.tag, opts as unknown as AskOptions);
    if (mocked !== undefined) return String(mocked);
  }
  const apiKey = getApiKey();
  if (!apiKey) throw new AiError('no-key', 'Add your Anthropic API key to use AI features.');
  const Anthropic = await loadSdk();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: opts.prompt }];
  let text = '';
  // A long server-tool turn can stop with `pause_turn`; send it back to continue.
  for (let round = 0; round < 4; round++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await client.beta.messages.create(
        {
          model: AI_MODEL,
          max_tokens: opts.maxTokens ?? 8000,
          output_config: { effort: 'low' },
          tools: [
            {
              type: 'web_search_20260209',
              name: 'web_search',
              max_uses: opts.maxSearches ?? 4,
              ...(opts.allowedDomains?.length ? { allowed_domains: opts.allowedDomains } : {}),
            },
          ],
          ...(opts.system ? { system: opts.system } : {}),
          messages,
        },
        { signal: opts.signal },
      );
    } catch (e) {
      mapApiError(Anthropic, e);
    }
    if (message.stop_reason === 'refusal') throw new AiError('refused', 'The model declined this request.');
    text += message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
  }
  if (!text.trim()) throw new AiError('bad-output', 'The search came back empty.');
  return text.trim();
}

/** Wording for a failed AI call, whatever was thrown. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Request failed.';
}

export const isAbort = (e: unknown): boolean => e instanceof AiError && e.kind === 'aborted';
