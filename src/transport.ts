import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { ClaudeSessionOptions, StreamEvent } from './types';

/**
 * Spawns `claude -p --input-format stream-json --output-format stream-json`
 * and keeps it alive across many user messages. Stdin stays open for the
 * lifetime of the transport — write user messages with sendUserMessage(),
 * receive parsed StreamEvent objects via the 'event' EventEmitter event.
 *
 * Single-responsibility: process lifecycle + line-buffered NDJSON parsing.
 * Knows nothing about turn semantics, queues, or session resumption — the
 * higher-level ClaudeSession layer handles that.
 */
export class StreamJsonTransport extends EventEmitter {
  private proc: ChildProcess | null = null;
  private lineBuffer = '';
  private stderrBuf = '';
  private exited = false;

  constructor(private opts: ClaudeSessionOptions) {
    super();
  }

  start(): void {
    if (this.proc) throw new Error('Transport already started');

    const args = this.buildArgs();

    // Strip CLAUDE_CODE_* env vars so the spawned claude doesn't think it's
    // running inside another Claude session (which would otherwise confuse
    // session tracking when this SDK is itself invoked from Claude Code).
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.opts.env ?? {}) };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    delete env['CLAUDE_CODE_SESSION_ID'];
    delete env['CLAUDE_CODE_VERSION'];

    const claudePath = this.opts.claudePath ?? 'claude';
    const cwd = this.opts.cwd ?? process.cwd();

    this.proc = spawn(claudePath, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.onStdoutData(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString('utf8');
    });

    this.proc.on('close', (code) => {
      this.exited = true;
      this.emit('exit', { code, stderr: this.stderrBuf });
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private buildArgs(): string[] {
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    if (this.opts.sessionId) {
      args.push('--session-id', this.opts.sessionId);
    }

    if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId);
    } else if (this.opts.systemPrompt) {
      // System prompt is only honored on a fresh session, not on resume.
      args.push('--system-prompt', this.opts.systemPrompt);
    }

    if (this.opts.persistSession === false) {
      args.push('--no-session-persistence');
    }

    if (this.opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (this.opts.permissionMode) {
      args.push('--permission-mode', this.opts.permissionMode);
    }

    if (this.opts.tools !== undefined) {
      args.push('--tools', this.opts.tools);
    }

    if (this.opts.allowedTools && this.opts.allowedTools.length > 0) {
      args.push('--allowed-tools', ...this.opts.allowedTools);
    }

    if (this.opts.disallowedTools && this.opts.disallowedTools.length > 0) {
      args.push('--disallowed-tools', ...this.opts.disallowedTools);
    }

    if (this.opts.model) {
      args.push('--model', this.opts.model);
    }

    return args;
  }

  /**
   * Inject a user message into the running session. Encoded as a single
   * line-delimited stream-json frame.
   */
  sendUserMessage(text: string): void {
    if (!this.proc || this.exited) {
      throw new Error('Transport not running');
    }
    const frame = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
    this.proc.stdin!.write(JSON.stringify(frame) + '\n');
  }

  private onStdoutData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8');
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(trimmed) as StreamEvent;
      } catch {
        // Drop malformed lines silently — claude occasionally emits non-JSON
        // diagnostic lines on stderr but stdout should always be NDJSON.
        continue;
      }
      this.emit('event', parsed);
    }
  }

  /** Close stdin and wait for the subprocess to exit. SIGTERM after `graceMs`. */
  async close(graceMs = 2000): Promise<void> {
    if (!this.proc || this.exited) return;

    try {
      this.proc.stdin!.end();
    } catch { /* ignore — stdin may already be closed */ }

    return new Promise<void>((resolve) => {
      const proc = this.proc!;
      const timer = setTimeout(() => {
        if (!this.exited) proc.kill('SIGTERM');
      }, graceMs);

      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.exited;
  }
}
