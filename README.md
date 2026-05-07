# claude-inject

An SDK that launches a Claude Code session in a child process and lets you inject prompts into it programmatically — getting structured event streams and full text replies back.

## Why

Some orgs disable experimental Claude Code features — including the channel mechanism that the Talkative and WhatsApp plugins rely on for inbound event delivery. With channels off, MCP-based plugins can call tools but can't push notifications into the conversation.

`claude-inject` is a different injection path that doesn't depend on the experimental channel API. Instead of pushing events into a session the human owns, your code *owns* a long-lived `claude` process and feeds it prompts.

It's not a perfect channels replacement (the human isn't in the loop), but it's good enough for plenty of agentic use cases.

## How it works

Under the hood, the SDK spawns:

```
claude -p --input-format stream-json --output-format stream-json \
          --include-partial-messages --verbose
```

That keeps `claude` alive across many user messages: each `session.send(...)` writes a single line of NDJSON to stdin, and the SDK parses the streamed events back out of stdout. There's no PTY scraping and no terminal escape-code parsing — everything is structured.

## Install

```bash
npm install @buzzie-ai/claude-inject
```

Requires Node ≥ 20 and the `claude` CLI (Claude Code) on your PATH (or pass `claudePath` explicitly).

### Local development

```bash
git clone https://github.com/Buzzie-AI/claude-inject
cd claude-inject
npm install
npm run build
```

## Quick start

```ts
import { ClaudeSession } from '@buzzie-ai/claude-inject';

const session = new ClaudeSession({
  cwd: process.cwd(),
  systemPrompt: 'You are a helpful assistant. Be concise.',
});

session.on('chunk', (text) => process.stdout.write(text));
session.on('tool_use', ({ name }) => console.log(`[${name}]`));

await session.start();
const reply = await session.send('Hello, what is 2 + 2?');
console.log('\nReply:', reply);

const reply2 = await session.send('And times 3?');
console.log('\nReply2:', reply2);  // same session — claude remembers turn 1

await session.close();
```

## API

### `new ClaudeSession(options)`

| Option | Type | Notes |
|---|---|---|
| `cwd` | `string` | Working dir. Defaults to `process.cwd()`. |
| `systemPrompt` | `string` | Sent on first start; ignored on resume. |
| `claudePath` | `string` | Path to `claude`. Defaults to PATH lookup. |
| `tools` | `string` | `""` disables all, `"default"` enables all, or `"Bash,Edit,Read"`. |
| `allowedTools` | `string[]` | Allowlist alternative to `tools`. |
| `disallowedTools` | `string[]` | Denylist. |
| `permissionMode` | `'acceptEdits' \| 'auto' \| 'bypassPermissions' \| 'default' \| 'dontAsk' \| 'plan'` | |
| `dangerouslySkipPermissions` | `boolean` | Equivalent to `--dangerously-skip-permissions`. |
| `model` | `string` | Alias (`opus`, `sonnet`, `haiku`) or full ID. |
| `sessionId` | `string` | Pin the session UUID. |
| `resumeSessionId` | `string` | Resume an existing session by UUID. |
| `persistSession` | `boolean` | Defaults to `true` (matches the CLI). |
| `env` | `NodeJS.ProcessEnv` | Extra env vars. |

### Methods

- **`start(): Promise<void>`** — spawn `claude` and resolve as soon as the subprocess is running. (In stream-json input mode, claude doesn't emit anything until you send the first message, so `sessionId` is populated during the first `send()`, not during `start()`.)
- **`send(prompt: string): Promise<string>`** — inject a prompt, resolve with the full text reply. Multiple concurrent calls queue (FIFO).
- **`close(): Promise<void>`** — close stdin and wait for the subprocess to exit.

### Getters

- **`busy: boolean`** — true while a `send()` is in flight or queued.
- **`sessionId: string | null`** — captured from the `system/init` event.

### Events

| Event | Payload | When |
|---|---|---|
| `chunk` | `string` | Text deltas as they stream |
| `tool_use` | `{ id, name, input }` | A tool call starts |
| `tool_result` | `{ toolUseId, content, isError }` | A tool call's result is folded back in |
| `assistant_message` | `{ text }` | Full assistant turn (concatenation of all text blocks) |
| `result` | `{ text, isError, sessionId }` | A turn finishes |
| `error` | `Error` | Subprocess error |
| `exit` | `{ code, stderr }` | Subprocess exited |

### Concurrency

One `send()` is in flight at a time. Subsequent calls queue and resolve in order. Inspect with `session.busy`.

## Examples

- [`examples/simple/`](examples/simple/) — 25-line "start → send twice → close"
  ```bash
  npm run demo:simple
  ```
- [`examples/two-claudes/`](examples/two-claudes/) — the original Director / Builder / Worker TUI demo, refactored to drive two `ClaudeSession`s
  ```bash
  npm run demo:two-claudes -- --builder --turns 6 --seed 'I want a program that prints hello world.'
  ```

## Tests

```bash
npm run test:session     # SDK end-to-end (spawn, send twice, assert)
npm run test:role-check  # Builder-mode role check via examples/two-claudes
npm test                 # both
```

## History

This started as the **Director pattern** carved out of the Talkative repo (origin: commit `1d98f64`, "Two Claude -p instances conversing via blessed side-by-side TUI"). The original code spawned one-shot `claude -p` subprocesses, ran a turn loop between two of them, and rendered side-by-side via `blessed`.

The SDK pivot replaces the one-shot pattern with a persistent `claude -p --input-format stream-json` subprocess that stays alive across many user messages — closer to what an interactive session feels like, but driven by code instead of a human keyboard. The original two-Claude TUI lives on as `examples/two-claudes/`.
