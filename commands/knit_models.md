---
description: Discover available models and propose tier assignments for the Loom
---

Use the `knit_models` tool to discover available models and propose tier assignments for the Loom's participants.

## When to Use

Invoke `knit_models` before `/knit` when you want to:
- Preview which models will be assigned to each tier
- Understand what models are available from your connected providers
- Verify model connectivity before starting a resource-intensive deliberation

## How It Works

The Loom discovers all models from your configured opencode providers (OpenAI, Anthropic, etc.) and scores them based on:
- **Cost**: Free models preferred for lower tiers
- **Reasoning capability**: Reasoning-capable models preferred for senior tiers
- **Context window**: Larger context preferred for principal tiers
- **Status**: Active models preferred over beta/deprecated

## Assignment Strategy

| Tier | Preference |
|------|-----------|
| principal | Best available model (reasoning, large context) |
| senior | Same as principal, or second-best |
| mid | Cost-effective model |
| junior | Most cost-effective model |

## Output

Returns a markdown table showing:
- Which model is assigned to each tier
- Provider and cost information
- Total available models

## Example

```
/knit_models
# Then use the output to run /knit with specific model overrides if desired
```
