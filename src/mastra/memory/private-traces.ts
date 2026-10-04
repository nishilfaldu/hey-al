import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';

// Conversation text belongs in memory under its retention policy, not in a second
// copy exported to a tracing service. Keep timings and numeric usage for diagnosis.
export class PrivateConversationTraces implements SpanOutputProcessor {
  name = 'private-conversation-traces';
  process(span?: AnySpan) {
    if (!span) return undefined;
    span.input = undefined;
    span.output = undefined;
    span.requestContext = undefined;
    span.errorInfo = undefined;
    span.metadata = {};
    span.attributes = Object.fromEntries(Object.entries(span.attributes ?? {}).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean'));
    return span;
  }
  async shutdown() {}
}
