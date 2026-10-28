import { internalKey } from '@sdlc/core';

// How the assistant talks to a model: one call with the conversation and the tools on offer, through the gateway's
// internal route. The cost comes back with the answer and is recorded by the caller.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelAnswer {
  content: Block[];
  stopReason: string | null;
  costMicros: number;
}

export interface AssistantModel {
  complete(req: {
    alias: string;
    system: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<ModelAnswer>;
}

export class GatewayAssistantModel implements AssistantModel {
  constructor(
    private readonly gatewayUrl: string,
    private readonly databaseUrl: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async complete(req: {
    alias: string;
    system: string;
    messages: ChatMessage[];
    tools: ToolSpec[];
    maxTokens?: number;
  }): Promise<ModelAnswer> {
    const res = await this.doFetch(`${this.gatewayUrl}/internal/assistant`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sdlc-internal': internalKey(this.databaseUrl),
      },
      body: JSON.stringify({
        alias: req.alias,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        max_tokens: req.maxTokens ?? 2000,
      }),
      signal: AbortSignal.timeout(130_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      content?: Block[];
      stopReason?: string | null;
      costMicros?: number;
      error?: string;
    } | null;
    if (!res.ok || !body || body.ok !== true)
      throw new Error(body?.error ?? `the model service answered ${res.status}`);
    return {
      content: Array.isArray(body.content) ? body.content : [],
      stopReason: body.stopReason ?? null,
      costMicros: Number(body.costMicros) || 0,
    };
  }
}
