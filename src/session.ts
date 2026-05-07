import { EventEmitter } from 'events';
import { StreamJsonTransport } from './transport';
import {
  AssistantMessageEvent,
  ClaudeSessionOptions,
  ExitEvent,
  ResultEvent,
  StreamEvent,
  ToolResultEvent,
  ToolUseEvent,
} from './types';

interface PendingSend {
  prompt: string;
  textBuf: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/**
 * A long-lived Claude Code session you can drive programmatically.
 *
 *   const s = new ClaudeSession({ cwd, systemPrompt });
 *   s.on('chunk', t => process.stdout.write(t));
 *   await s.start();
 *   const reply = await s.send('Hello');
 *   await s.close();
 *
 * One send() is in flight at a time; subsequent calls queue and resolve in
 * FIFO order. Use `session.busy` to introspect.
 */
export class ClaudeSession extends EventEmitter {
  private transport: StreamJsonTransport;
  private queue: PendingSend[] = [];
  private inflight: PendingSend | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private _started = false;
  private _closed = false;
  private _sessionId: string | null = null;

  constructor(opts: ClaudeSessionOptions = {}) {
    super();
    this.transport = new StreamJsonTransport(opts);
    this.transport.on('event', (e: StreamEvent) => this.onEvent(e));
    this.transport.on('exit', (info: ExitEvent) => this.onExit(info));
    this.transport.on('error', (err: Error) => this.emit('error', err));
  }

  /**
   * Spawn the claude subprocess and resolve once it's running.
   *
   * Note: in stream-json input mode, claude does not emit `system/init` (or any
   * other event) until the first user message is sent — so we don't wait for
   * init here, we resolve as soon as spawn succeeds. `sessionId` gets populated
   * from the init event whenever it does arrive (typically during the first
   * `send()` call). If the spawned process dies during startup, the exit
   * handler rejects this promise.
   */
  start(): Promise<void> {
    if (this._started) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      try {
        this.transport.start();
      } catch (err) {
        reject(err as Error);
        return;
      }
      this._started = true;
      this.startResolve = resolve;
      this.startReject = reject;
      // Defer resolution by a tick so an immediate spawn error/exit (ENOENT,
      // bad flags) gets a chance to fire and reject via onExit() instead.
      setImmediate(() => {
        if (this.startResolve) {
          this.startResolve();
          this.startResolve = null;
          this.startReject = null;
        }
      });
    });
  }

  /**
   * Inject a user message and resolve with the assistant's full text reply.
   * Multiple concurrent calls queue (FIFO) and resolve in order.
   */
  send(prompt: string): Promise<string> {
    if (!this._started) return Promise.reject(new Error('Session not started — call start() first'));
    if (this._closed) return Promise.reject(new Error('Session closed'));
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ prompt, textBuf: '', resolve, reject });
      this.drain();
    });
  }

  /** Close stdin and wait for the subprocess to exit. */
  async close(): Promise<void> {
    await this.transport.close();
  }

  /** True while a send() is in flight or queued. */
  get busy(): boolean {
    return this.inflight !== null || this.queue.length > 0;
  }

  /** UUID captured from the system/init event, or null before start completes. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  // ---- internals ----

  private drain(): void {
    if (this.inflight || this.queue.length === 0 || this._closed) return;
    const next = this.queue.shift()!;
    this.inflight = next;
    try {
      this.transport.sendUserMessage(next.prompt);
    } catch (err) {
      this.inflight = null;
      next.reject(err as Error);
      this.drain();
    }
  }

  private onExit(info: ExitEvent): void {
    this._closed = true;
    this.emit('exit', info);

    // Reject anything pending so callers don't hang forever.
    if (this.inflight) {
      this.inflight.reject(new Error(
        `claude exited (code ${info.code}). stderr: ${info.stderr.slice(0, 400)}`,
      ));
      this.inflight = null;
    }
    for (const p of this.queue) {
      p.reject(new Error('claude exited before processing prompt'));
    }
    this.queue = [];

    if (this.startReject && !this._started) {
      this.startReject(new Error(
        `claude exited during startup (code ${info.code}). stderr: ${info.stderr.slice(0, 400)}`,
      ));
      this.startReject = null;
      this.startResolve = null;
    }
  }

  private onEvent(e: StreamEvent): void {
    // system/init carries the session id. In stream-json input mode this
    // typically arrives during the first send(), not at startup.
    if (e.type === 'system' && e.subtype === 'init') {
      if (e.session_id) this._sessionId = e.session_id;
      return;
    }

    if (e.type === 'stream_event' && e.event) {
      const ev = e.event;

      // Text deltas as they stream — accumulate into the in-flight send buffer.
      if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        const text = ev.delta.text;
        this.emit('chunk', text);
        if (this.inflight) this.inflight.textBuf += text;
        return;
      }

      // Tool use start — useful for live UI feedback during long tool calls.
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        const evt: ToolUseEvent = {
          id: ev.content_block.id ?? '',
          name: ev.content_block.name ?? '',
          input: ev.content_block.input,
        };
        this.emit('tool_use', evt);
        return;
      }
    }

    // Tool results arrive as user-role messages with tool_result content blocks.
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const block of e.message!.content!) {
        if (block.type === 'tool_result') {
          const evt: ToolResultEvent = {
            toolUseId: block.tool_use_id ?? '',
            content: typeof block.content === 'string' ? block.content : '',
            isError: !!block.is_error,
          };
          this.emit('tool_result', evt);
        }
      }
      return;
    }

    // Final assistant message for a turn — full text content reassembled.
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      let text = '';
      for (const block of e.message!.content!) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
      if (text) {
        const evt: AssistantMessageEvent = { text };
        this.emit('assistant_message', evt);
      }
      return;
    }

    // result marks turn completion. Resolve (or reject) the inflight send().
    if (e.type === 'result') {
      const text = this.inflight?.textBuf ?? e.result ?? '';
      const evt: ResultEvent = {
        text,
        isError: !!e.is_error,
        sessionId: this._sessionId ?? '',
      };
      this.emit('result', evt);

      if (this.inflight) {
        const pending = this.inflight;
        this.inflight = null;
        if (e.is_error) {
          pending.reject(new Error(`Turn failed: ${e.result ?? 'unknown error'}`));
        } else {
          pending.resolve(text);
        }
        this.drain();
      }
      return;
    }
  }
}
