---
description: Start the Loom deliberation dashboard
---

Start the Loom deliberation dashboard server.

The dashboard is the sole control plane: open the URL, use the Setup tab to
preview the suggested room, approve personas (or pick manually), assign a model
to every seat, then start the deliberation. Progress streams in the Timeline
tab; the final synthesis lives in the Output tab. Nothing is returned to chat.

Parameters:
- `port` (optional): Port number for the dashboard server. Default: 3210.

The server runs until stopped. It binds to loopback by default and requires its per-dashboard capability cookie for API access. Output the URL for the user to open in their browser.
