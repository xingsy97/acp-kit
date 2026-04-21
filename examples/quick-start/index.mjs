#!/usr/bin/env node

import process from 'node:process';
import { createRuntime } from '@acp-kit/core';

const runtime = createRuntime({
  profile: 'copilot',
  cwd: process.cwd(),
  host: {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    log: (entry) => console.log(`[host:${entry.level}] ${entry.message}`),
  },
});

const session = await runtime.newSession();

session.on('event', (event) => {
  console.log(event.type, JSON.stringify(event));
});

try {
  const result = await session.prompt('Summarize this repository.');
  console.log(`stopReason: ${result.stopReason ?? 'unknown'}`);
} finally {
  await session.dispose();
}
