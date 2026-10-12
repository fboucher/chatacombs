import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createTestHarness } from './helpers/e2eHarness.js';
import { Simulator } from '../tools/simulator.js';

test('simulator - parses viewer commands and dispatches to HTTP API', async () => {
  const harness = await createTestHarness({ channel: 'simchannel' });

  try {
    const outputs = [];
    const sim = new Simulator({
      url: harness.serverUrl,
      channel: 'simchannel',
      key: harness.apiKey,
      output: (msg) => outputs.push(msg)
    });

    // Connect SSE in simulator
    await sim.connectSse();

    // Start stream
    await sim.handleInput('/start');
    assert.ok(outputs.some(o => o.includes("Stream lifecycle 'started'")));

    // Send vote command as alice
    await sim.handleInput('alice: !vote 1');

    // Send default hero command
    await sim.handleInput('!hero');

    // Change user
    await sim.handleInput('/user bob');
    assert.equal(sim.defaultUser, 'bob');

    // Inspect state
    await sim.handleInput('/state');
    assert.ok(outputs.some(o => o.includes('Current Game State')));

    // End stream
    await sim.handleInput('/end');
    assert.ok(outputs.some(o => o.includes("Stream lifecycle 'ended'")));

    sim.close();
  } finally {
    await harness.close();
  }
});

test('simulator - scriptable via piped input to child process', async () => {
  const harness = await createTestHarness({ channel: 'pipechannel' });

  try {
    const child = spawn(process.execPath, [
      'tools/simulator.js',
      '--url', harness.serverUrl,
      '--channel', 'pipechannel',
      '--key', harness.apiKey
    ], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });

    // Write piped commands into simulator stdin
    child.stdin.write('/start\n');
    child.stdin.write('alice: !vote 1\n');
    child.stdin.write('/lull 1\n');
    child.stdin.write('/end\n');
    child.stdin.end();

    await new Promise((resolve) => {
      child.on('close', resolve);
    });

    assert.ok(output.includes('CHATACOMBS INTERACTIVE TERMINAL SIMULATOR'));
    assert.ok(output.includes("Stream lifecycle 'started'"), `Expected stream started in output, got: ${output}`);
    assert.ok(output.includes('Simulating quiet lull for 1s'), `Expected lull in output, got: ${output}`);
    assert.ok(output.includes("Stream lifecycle 'ended'"), `Expected stream ended in output, got: ${output}`);
    assert.ok(output.includes('Exiting simulator'));
  } finally {
    await harness.close();
  }
});
