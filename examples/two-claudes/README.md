# two-claudes

The original Director / Worker / Builder demo, refactored to drive two `ClaudeSession` instances from the `claude-inject` SDK.

## Run it

```bash
# Two playful agents trading one-line replies
npm run demo:two-claudes -- --turns 6 --seed 'Talk to me about ravens.'

# Director mode: Agent A directs Agent B (which has full tool access)
npm run demo:two-claudes -- --director --turns 12 --seed 'Run the PM agent and have it draft a one-line PRD.'

# Builder mode: a non-technical PM tells an engineer to build something
npm run demo:two-claudes -- --builder --turns 12 --seed 'I want a program that prints hello world.'
```

In Builder mode, output is written to `output/session-<timestamp>/`.

## What this demonstrates

Two long-lived `ClaudeSession`s in the same process. Each pane is wired to the session's `chunk` / `tool_use` / `tool_result` events. Turn coordination is just `await session.send(lastMessage)` in a loop — the SDK owns the persistent claude subprocess and the resume bookkeeping that the original `runClaude` carve-out did manually.

See `loop.ts` for the (now ~30-line) coordinator and `index.ts` for the CLI / system-prompt presets.
