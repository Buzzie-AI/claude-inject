// Smallest possible demo of the claude-inject SDK.
//
//   npx tsx examples/simple/index.ts
//
// Spawns one claude process, sends two prompts on the same session, prints
// each reply, then closes cleanly.

import { ClaudeSession } from '../../src';

async function main(): Promise<void> {
  const session = new ClaudeSession({
    cwd: process.cwd(),
    systemPrompt: 'You are a concise assistant. Reply in one short sentence.',
    persistSession: false,
    tools: '', // no tools, just text
  });

  // Stream chunks live so you can see them as they arrive.
  session.on('chunk', (text) => process.stdout.write(text));

  await session.start();
  process.stdout.write('> ');

  await session.send('Greet me.');
  process.stdout.write(`\n\n[session ${session.sessionId}]\n\n> `);

  // Same session — claude remembers the previous turn.
  await session.send('Now tell me one fun fact about ravens.');
  process.stdout.write('\n\n');

  await session.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
