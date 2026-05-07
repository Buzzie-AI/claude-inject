// Raw stream-json shapes emitted by `claude -p --output-format stream-json`.
// Used internally by StreamJsonTransport. Permissive on purpose — claude can
// add fields and we want to ignore unknowns rather than crash.
export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  event?: {
    type: string;
    delta?: { type: string; text?: string; partial_json?: string };
    content_block?: { type: string; name?: string; id?: string; input?: unknown };
    index?: number;
  };
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      content?: string | unknown;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
  result?: string;
  is_error?: boolean;
}

// Public SDK types

export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

export interface ClaudeSessionOptions {
  /** Working directory for the spawned claude process. Defaults to process.cwd(). */
  cwd?: string;
  /** System prompt for the session. Sent on first start; ignored on resume. */
  systemPrompt?: string;
  /** Path to the `claude` executable. Defaults to looking it up on PATH. */
  claudePath?: string;
  /** Tool list. `""` disables all tools, `"default"` enables all, or `"Bash,Edit,Read"`. */
  tools?: string;
  /** Allowed tools list (alternative to `tools`). */
  allowedTools?: string[];
  /** Disallowed tools list. */
  disallowedTools?: string[];
  /** Permission mode passed to claude. */
  permissionMode?: PermissionMode;
  /** Bypass all permission checks. Equivalent to --dangerously-skip-permissions. */
  dangerouslySkipPermissions?: boolean;
  /** Model alias (`opus`, `sonnet`, `haiku`) or full ID. */
  model?: string;
  /** Specific session UUID to use. If omitted, claude assigns one. */
  sessionId?: string;
  /** Resume an existing session by ID. When set, the system prompt is skipped. */
  resumeSessionId?: string;
  /** Persist session to disk. Defaults to true (matches the CLI default). */
  persistSession?: boolean;
  /** Extra env vars to merge into the spawned process. */
  env?: NodeJS.ProcessEnv;
}

export interface ToolUseEvent {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface AssistantMessageEvent {
  text: string;
}

export interface ResultEvent {
  text: string;
  isError: boolean;
  sessionId: string;
}

export interface ExitEvent {
  code: number | null;
  stderr: string;
}
