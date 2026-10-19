// How the platform asks a model something itself, through the gateway, with a run's token (so the gateway's alias rules,
// budget and cost record apply as they do for any run). One question, one answer, no tools.

export interface InlineModel {
  ask(
    token: string,
    q: {
      alias: string;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    },
  ): Promise<string>;
}

export class GatewayModel implements InlineModel {
  constructor(
    private readonly baseUrl: string,
    private readonly doFetch: typeof fetch = fetch,
    private readonly timeoutMs = 240_000,
  ) {}

  async ask(
    token: string,
    q: {
      alias: string;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      maxTokens?: number;
    },
  ): Promise<string> {
    const res = await this.doFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: q.alias,
        max_tokens: q.maxTokens ?? 8000,
        system: q.system,
        messages: q.messages,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // keep the raw text
      }
      throw new Error(`the model call failed (${res.status}): ${message.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { content?: Array<{ type: string; text?: string }> };
    const answer = (body.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!answer) throw new Error('the model answered with no text');
    return answer;
  }
}
