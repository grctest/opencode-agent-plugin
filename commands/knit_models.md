---
description: Discover available models and manage model assignments
---

Use the `knit_models` tool to manage which models Loom agents can use.

**Commands:**
- `/knit_models` — List all discovered models with their exact identifiers and proposed tier assignments
- `/knit_models enable <provider/model> <provider/model> ...` — Enable specific models (exact identifier matching)
- `/knit_models disable <provider/model> <provider/model> ...` — Disable specific models
- `/knit_models reset` — Reset to all available models (clear filter)

**Example:** `/knit_models enable openai/gpt-4.1 anthropic/claude-3-5-sonnet`

When enabling or disabling, always use the exact `provider/model` identifier shown in the list output.
