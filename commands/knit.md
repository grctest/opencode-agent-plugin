---
description: Start a multi-agent deliberation session (a 'Loom')
---

Use the `knit` tool to start a Loom deliberation about: $ARGUMENTS

If `$ARGUMENTS` is empty, tell the user: "Usage: /knit \"your question\" — a question is required (≥3 chars)."

Args: question (required), context?, participants? (name/persona/agenda/tier), max_rounds? 1-10, models? [{tier,provider_id,model_id}], dry_run?, meeting_timeout? 0-3600000, fresh?
