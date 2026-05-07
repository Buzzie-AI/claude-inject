import { ClaudeSession } from '../../src';
import * as tui from './tui';

export interface LoopConfig {
  seed: string;
  systemA: string;
  systemB: string;
  turns: number;
  timeoutSecs: number;
  claudePath: string;
  cwdA: string;
  cwdB: string;
  /** Director (Agent A) is text-only when this is false. */
  toolsA: boolean;
  /** Worker (Agent B) typically gets full tools + skip-permissions. */
  skipPermissionsB: boolean;
  /** Don't persist Agent A's session to disk (used for Director/Builder). */
  noSessionPersistenceA?: boolean;
}

export async function runLoop(config: LoopConfig): Promise<void> {
  const sessionA = new ClaudeSession({
    cwd: config.cwdA,
    systemPrompt: config.systemA,
    claudePath: config.claudePath,
    // Director gets no tools — must produce text only.
    tools: config.toolsA ? undefined : '',
    persistSession: config.noSessionPersistenceA ? false : undefined,
  });

  const sessionB = new ClaudeSession({
    cwd: config.cwdB,
    systemPrompt: config.systemB,
    claudePath: config.claudePath,
    dangerouslySkipPermissions: config.skipPermissionsB,
  });

  // Wire up the panes
  sessionA.on('chunk', tui.appendA);
  sessionA.on('tool_use', ({ name }) => tui.appendA(`\n⚙ ${name}…\n`));
  sessionA.on('tool_result', ({ content }) => {
    if (content) tui.appendA(`  → ${content.slice(0, 120).replace(/\n/g, ' ')}\n`);
  });

  sessionB.on('chunk', tui.appendB);
  sessionB.on('tool_use', ({ name }) => tui.appendB(`\n⚙ ${name}…\n`));
  sessionB.on('tool_result', ({ content }) => {
    if (content) tui.appendB(`  → ${content.slice(0, 120).replace(/\n/g, ' ')}\n`);
  });

  await Promise.all([sessionA.start(), sessionB.start()]);

  const cleanup = async () => {
    await Promise.allSettled([sessionA.close(), sessionB.close()]);
  };

  let lastMessage = config.seed;
  let completedTurns = 0;

  tui.appendA(`[Seed] ${config.seed}\n\n---\n\n`);

  for (let turn = 1; turn <= config.turns; turn++) {
    const agent: 'A' | 'B' = turn % 2 === 1 ? 'A' : 'B';
    const session = agent === 'A' ? sessionA : sessionB;
    const append = agent === 'A' ? tui.appendA : tui.appendB;

    tui.setThinking(turn, agent);

    const t0 = Date.now();
    let reply: string;
    try {
      reply = await session.send(lastMessage);
    } catch (err: unknown) {
      tui.setError(`Turn ${turn} (Agent ${agent}): ${err instanceof Error ? err.message : String(err)}`);
      await cleanup();
      return;
    }

    completedTurns = turn;

    if (!reply) {
      tui.setError(`Turn ${turn} (Agent ${agent}): empty response`);
      await cleanup();
      return;
    }

    append('\n\n---\n\n');
    lastMessage = reply;

    tui.setStatus(turn, agent, Date.now() - t0);

    // Director signals completion with DONE — exit cleanly after a short pause.
    if (agent === 'A' && reply.toUpperCase().includes('DONE')) {
      tui.setStatus(completedTurns, 'done');
      setTimeout(async () => {
        await cleanup();
        tui.destroy();
        process.exit(0);
      }, 3000);
      return;
    }
  }

  tui.setStatus(completedTurns, 'done');
  setTimeout(async () => {
    await cleanup();
    tui.destroy();
    process.exit(0);
  }, 3000);
}
