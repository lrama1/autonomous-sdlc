import type { Usage } from '@sdlc/core';

/** Reads token usage from an Anthropic Messages stream. Feed it decoded text chunks as they arrive. */
export class SseMeter {
  usage: Usage = { inputTokens: 0, cacheWriteTokens: 0, cachedTokens: 0, outputTokens: 0 };
  /** The model id the provider reports in message_start. */
  model: string | undefined;
  private tail = '';

  push(chunk: string): void {
    this.tail += chunk;
    let i: number;
    while ((i = this.tail.indexOf('\n')) >= 0) {
      this.line(this.tail.slice(0, i));
      this.tail = this.tail.slice(i + 1);
    }
  }

  finish(): void {
    if (this.tail) this.line(this.tail);
    this.tail = '';
  }

  private line(line: string): void {
    if (!line.startsWith('data:')) return;
    let ev: { type?: string; message?: { model?: string; usage?: RawUsage }; usage?: RawUsage };
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    // message_start carries the input side. message_delta carries cumulative totals, so replace, never add.
    if (ev.type === 'message_start') {
      this.model = ev.message?.model;
      this.apply(ev.message?.usage);
    } else if (ev.type === 'message_delta') {
      this.apply(ev.usage);
    }
  }

  private apply(u: RawUsage | undefined): void {
    if (!u) return;
    if (typeof u.input_tokens === 'number') this.usage.inputTokens = u.input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number')
      this.usage.cacheWriteTokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === 'number')
      this.usage.cachedTokens = u.cache_read_input_tokens;
    if (typeof u.output_tokens === 'number') this.usage.outputTokens = u.output_tokens;
  }
}

interface RawUsage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

/** Usage from a non-streaming Messages response body. */
export function usageFromJson(body: string): { usage: Usage; model?: string } {
  const meter = new SseMeter();
  try {
    const j = JSON.parse(body) as { model?: string; usage?: RawUsage };
    meter.push(
      `data: ${JSON.stringify({ type: 'message_start', message: { model: j.model, usage: j.usage } })}\n`,
    );
  } catch {
    // not JSON (an error page): no usage
  }
  return { usage: meter.usage, model: meter.model };
}
