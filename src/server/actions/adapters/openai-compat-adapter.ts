/* ============================================================================
   openai-compat-adapter.ts — opt-in real-model execution via ANY OpenAI-compatible
   chat-completions API (DeepSeek, MiniMax, Together, Groq, a local vLLM, …).

   Swapping models is a config change, not a code change: point the env at any
   provider that speaks the OpenAI /chat/completions shape.

     ROUNDTABLE_OPENAI_BASE_URL   e.g. https://api.deepseek.com/v1
     ROUNDTABLE_OPENAI_MODEL      e.g. deepseek-v4-flash
     ROUNDTABLE_OPENAI_API_KEY    the bearer token

   Like the other real adapters this is opt-in and never a silent fallback: with
   no key it throws OpenAICompatUnavailableError, which the dispatch layer catches
   to fall back to local-dispatch (surfaced on the task, not hidden).

   Reasoning models (DeepSeek V4, MiniMax M-series, …) return the final answer in
   the standard `content` field and keep chain-of-thought in `reasoning_content`;
   we read `content` and surface reasoning length for observability only.
   ============================================================================ */

export type OpenAICompatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type OpenAICompatRunInput = {
  messages: OpenAICompatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  timeoutMs?: number | undefined;
};

export type OpenAICompatRunOutput = {
  text: string;
  reasoning?: string | undefined;
  raw: string;
  usage?: Record<string, unknown> | undefined;
};

export class OpenAICompatUnavailableError extends Error {
  readonly code = 'openai_compat_unavailable';
  constructor(message = 'openai_compat_unavailable') {
    super(message);
    this.name = 'OpenAICompatUnavailableError';
  }
}

export class OpenAICompatRequestError extends Error {
  readonly code = 'openai_compat_request_failed';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenAICompatRequestError';
  }
}

function apiKey(): string | undefined {
  const key = process.env.ROUNDTABLE_OPENAI_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

export function isOpenAICompatAvailable(): boolean {
  return Boolean(apiKey() && process.env.ROUNDTABLE_OPENAI_BASE_URL && process.env.ROUNDTABLE_OPENAI_MODEL);
}

function baseUrl(): string {
  return (process.env.ROUNDTABLE_OPENAI_BASE_URL || '').replace(/\/$/, '');
}

export function openAICompatModel(): string {
  return process.env.ROUNDTABLE_OPENAI_MODEL || 'unknown-model';
}

/**
 * Run a chat completion against the configured OpenAI-compatible endpoint.
 * Throws OpenAICompatUnavailableError when unconfigured, OpenAICompatRequestError
 * on a non-2xx / API-level error.
 */
export async function runOnOpenAICompat(input: OpenAICompatRunInput): Promise<OpenAICompatRunOutput> {
  if (!isOpenAICompatAvailable()) {
    throw new OpenAICompatUnavailableError(
      'ROUNDTABLE_OPENAI_BASE_URL / _MODEL / _API_KEY are not all set',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: openAICompatModel(),
        messages: input.messages,
        max_tokens: input.maxTokens ?? 8192,
        temperature: input.temperature ?? 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenAICompatRequestError(`openai_compat_network_error: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: Record<string, unknown>;
    error?: { message?: string };
    // Some providers (e.g. MiniMax) surface app-level errors on HTTP 200.
    base_resp?: { status_code?: number; status_msg?: string };
  };

  if (!response.ok) {
    throw new OpenAICompatRequestError(data.error?.message || `http_${response.status}`, response.status);
  }
  if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    throw new OpenAICompatRequestError(
      `provider_${data.base_resp.status_code}: ${data.base_resp.status_msg ?? 'error'}`,
    );
  }

  const message = data.choices?.[0]?.message;
  const raw = message?.content ?? '';
  const reasoning = message?.reasoning_content?.trim() || undefined;
  return { text: raw.trim(), reasoning, raw, usage: data.usage };
}
