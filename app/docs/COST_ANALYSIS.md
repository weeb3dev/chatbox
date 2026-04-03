# ChatBridge AI Cost Analysis

## 1. Development and Testing Costs

Pull these numbers from the Cloudflare AI Gateway dashboard:

**Dashboard location:** [Cloudflare Dashboard](https://dash.cloudflare.com) > AI > AI Gateway > `chatbridge-gateway` > Analytics

| Metric | Value |
|--------|-------|
| Total API requests | _fill from dashboard_ |
| Total input tokens | _fill from dashboard_ |
| Total output tokens | _fill from dashboard_ |
| Total spend (Anthropic) | _calculate: (input tokens / 1M * $3) + (output tokens / 1M * $15)_ |
| Cache hit rate | _fill from dashboard_ |
| Estimated savings from cache | _fill from dashboard_ |
| Average latency (p50) | _fill from dashboard_ |
| Average latency (p99) | _fill from dashboard_ |

### How to export

1. Navigate to the AI Gateway analytics page.
2. Set the date range to cover your full development period.
3. Screenshot the overview dashboard (requests, tokens, latency distribution).
4. Export CSV if available via the "Export" button on the analytics page.
5. Note the cost breakdown by metadata tags (`userId`, `appId`) to see which apps consume the most tokens.

### Cloudflare infrastructure costs (development)

| Resource | Free tier | Paid tier |
|----------|-----------|-----------|
| Workers requests | 100K/day | $0.30/M requests |
| Workers CPU time | 10ms/invocation | 30ms/invocation ($5/mo base) |
| D1 reads | 5M/day | $0.001/M reads |
| D1 writes | 100K/day | $1.00/M writes |
| D1 storage | 5 GB | $0.75/GB-month |
| KV reads | 100K/day | $0.50/M reads |
| KV writes | 1K/day | $5.00/M writes |
| Durable Objects requests | Included with paid | $0.15/M requests |
| Durable Objects duration | Included with paid | $12.50/M GB-s |
| Pages (app hosting) | Unlimited | Unlimited |

Workers paid plan ($5/month) is recommended for the 30ms CPU limit -- streaming Claude responses often exceeds the free tier's 10ms limit.

## 2. Production Cost Projections

### Assumptions

| Parameter | Value | Notes |
|-----------|-------|-------|
| Messages per session | 20 | Average conversation length |
| Sessions per user per month | 10 | |
| Average input tokens per message | 3,000 | Includes system prompt, conversation history, tool schemas |
| Average output tokens per message | 1,000 | Claude's response |
| Tool calls per session | 3 | Average tool invocations |
| Additional tokens per tool call | 500 input + 200 output | Tool result round-trip |

### Claude API costs (Sonnet 4)

**Pricing:** $3.00 per million input tokens, $15.00 per million output tokens.

| Users | Messages/mo | Input tokens/mo | Output tokens/mo | Input cost | Output cost | Total AI cost/mo |
|-------|------------|-----------------|------------------|------------|-------------|-----------------|
| 100 | 20,000 | 63M | 22M | $189 | $330 | **$519** |
| 1,000 | 200,000 | 630M | 220M | $1,890 | $3,300 | **$5,190** |
| 10,000 | 2,000,000 | 6.3B | 2.2B | $18,900 | $33,000 | **$51,900** |
| 100,000 | 20,000,000 | 63B | 22B | $189,000 | $330,000 | **$519,000** |

**Token calculation per message:**
- Base: 3,000 input + 1,000 output
- Tool overhead per session: 3 calls * (500 + 200) = 2,100 extra tokens
- Per message average with tool overhead: 3,000 + (2,100 / 20) = 3,105 input, 1,000 + (600 / 20) = 1,030 output
- Rounded to 3,150 input and 1,100 output per message for the projections.

### Cloudflare infrastructure costs (production)

| Users | Workers requests/mo | D1 reads/mo | D1 writes/mo | DO requests/mo | Est. CF cost/mo |
|-------|-------------------|-------------|-------------|---------------|----------------|
| 100 | ~60K | ~200K | ~40K | ~20K | **$5** (base plan) |
| 1,000 | ~600K | ~2M | ~400K | ~200K | **~$8** |
| 10,000 | ~6M | ~20M | ~4M | ~2M | **~$35** |
| 100,000 | ~60M | ~200M | ~40M | ~20M | **~$250** |

Cloudflare infrastructure is negligible compared to AI API costs at all scales.

## 3. Cost Optimization Strategies

### Implemented

**Lazy schema loading** -- Tool schemas are only included in Claude's context when the relevant app is active. A conversation that never uses chess doesn't pay the token cost of chess tool definitions (~200 tokens per tool * 4 tools = 800 tokens saved per message).

**AI Gateway caching** -- Identical requests return cached responses. Effective for repeated queries like "list available apps" or similar system-level tool calls. Estimated savings: **10-15%** on total requests (higher for apps with predictable tool patterns).

**Retry with backoff** -- Failed requests aren't wasted. The retry strategy (3 attempts, exponential backoff) recovers from transient 429/5xx errors without user intervention.

### Projected optimizations

**Dynamic model routing** (stretch goal) -- Route simple queries (greetings, clarifications, list requests) to Claude Haiku ($0.25/$1.25 per M tokens) and reserve Sonnet for complex reasoning and tool orchestration.

| Routing | Haiku % | Sonnet % | Cost at 1K users | Savings |
|---------|---------|----------|-----------------|---------|
| No routing | 0% | 100% | $5,190 | -- |
| Conservative | 30% | 70% | $3,740 | 28% |
| Aggressive | 50% | 50% | $2,980 | 43% |

**Context summarization** (future) -- For long conversations (30+ messages), summarize older messages into a condensed context block instead of sending the full history. Reduces input tokens per message from O(n) to O(1) relative to conversation length.

Estimated savings at 50-message conversations: **40-60%** on input tokens.

**Token budget per conversation** -- Cap the maximum input context at a configurable token limit (e.g., 50K tokens). When exceeded, automatically summarize or truncate oldest messages. Prevents runaway costs from very long sessions.

**Prompt caching** (Anthropic feature) -- The system prompt and tool definitions are largely static within a session. Anthropic's prompt caching reduces cost for the repeated prefix. Estimated savings: **up to 90%** on cached prefix tokens (system prompt + tool schemas = ~2K tokens/message).

### Cost per user benchmarks

| Optimization level | Monthly cost per user (at 10 sessions, 20 msgs each) |
|-------------------|------------------------------------------------------|
| Current (Sonnet only, no caching) | ~$5.19 |
| With AI Gateway cache (15%) | ~$4.41 |
| With prompt caching (est. 30% total) | ~$3.63 |
| With dynamic routing (30% Haiku) | ~$3.74 |
| All optimizations combined | ~$2.00 - $2.50 |

At $2.50/user/month AI cost, a $10/month subscription tier would be viable with healthy margins for infrastructure and growth.
