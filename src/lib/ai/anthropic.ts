// Minimal Claude API client (Messages API with JSON structured outputs). No SDK, injectable fetch,
// and nothing from the email ever ends up in error messages or logs.
import type { JsonSchema } from "./schemas.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
const REAL_BASE = "https://api.anthropic.com";

/** Tests may point Claude calls at a fake server. Never honoured on a Vercel production deploy. */
export function anthropicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANTHROPIC_API_BASE_OVERRIDE?.replace(/\/+$/, "");
  return override && env.VERCEL_ENV !== "production" ? override : REAL_BASE;
}

export class ClaudeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** Worth retrying later: rate limits, overload, server errors, timeouts (status 0). */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status === 529 || this.status >= 500;
  }
  /** The key is missing, wrong or out of credit: no point retrying until an admin fixes it. */
  get isAccountProblem(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 402;
  }
}

export type JsonCall = {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  schema: JsonSchema;
  maxTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type JsonResult = { data: unknown; inputTokens: number; outputTokens: number; stopReason: string | null };

export async function callJson(call: JsonCall): Promise<JsonResult> {
  let response: Response;
  try {
    response = await (call.fetchImpl ?? fetch)(`${call.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": call.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxTokens,
        system: call.system,
        messages: [{ role: "user", content: call.user }],
        output_config: { format: { type: "json_schema", schema: call.schema } },
      }),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ClaudeApiError(0, timedOut ? "Claude didn't answer in time" : "Couldn't reach Claude");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { type?: string } };
    throw new ClaudeApiError(response.status, `Claude answered ${response.status}${body.error?.type ? ` (${body.error.type})` : ""}`);
  }

  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;
  const stopReason = body.stop_reason ?? null;
  const text = body.content?.find((c) => c.type === "text")?.text;

  let data: unknown = undefined;
  if (stopReason !== "refusal" && stopReason !== "max_tokens" && typeof text === "string") {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  return { data, inputTokens, outputTokens, stopReason };
}
