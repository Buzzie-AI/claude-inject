// End-to-end SDK test. Spawns a real claude process, sends two prompts on the
// same session, asserts both replies. Proves the persistent stream-json
// transport actually stays alive across turns — the linchpin assumption of
// the SDK pivot.
//
// Run with: npx tsx test/session.test.ts

import { ClaudeSession } from '../src';

async function run(): Promise<void> {
  console.log('Starting session test...\n');

  const session = new ClaudeSession({
    cwd: process.cwd(),
    systemPrompt: 'You are a test assistant. Reply with EXACTLY the single word the user asks for, lowercase, no punctuation.',
    persistSession: false,
    tools: '',
  });

  let chunks = '';
  session.on('chunk', (text) => { chunks += text; });

  let resultEvents = 0;
  session.on('result', () => { resultEvents++; });

  const t0 = Date.now();
  await session.start();
  console.log(`✓ Session started in ${Date.now() - t0}ms (sessionId arrives during first send)`);

  // Turn 1
  const reply1 = (await session.send('Reply with the single word: pong')).trim().toLowerCase();
  console.log(`Turn 1 reply: "${reply1}" (sessionId now: ${session.sessionId})`);
  if (!/pong/.test(reply1)) {
    throw new Error(`FAIL: expected "pong" in reply, got "${reply1}"`);
  }
  if (!session.sessionId) {
    throw new Error('FAIL: sessionId still null after first turn');
  }
  console.log('✓ Turn 1: response contained "pong" and sessionId was captured');

  if (!chunks) {
    throw new Error('FAIL: chunk events did not fire during turn 1');
  }
  console.log('✓ chunk events fired during turn 1');

  // Turn 2 — proves persistence across turns. Use a different word to make
  // sure we're not just re-reading turn 1's buffered output.
  const reply2 = (await session.send('Now reply with the single word: ping')).trim().toLowerCase();
  console.log(`Turn 2 reply: "${reply2}"`);
  if (!/ping/.test(reply2)) {
    throw new Error(`FAIL: expected "ping" in second reply, got "${reply2}"`);
  }
  console.log('✓ Turn 2: response contained "ping" (multi-turn persistence works)');

  if (resultEvents < 2) {
    throw new Error(`FAIL: expected >=2 result events, got ${resultEvents}`);
  }
  console.log(`✓ Got ${resultEvents} result events (one per turn)`);

  await session.close();
  console.log('✓ Session closed cleanly');

  console.log('\n✓ All session tests passed');
}

run().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
