import process from 'node:process';
import { createInterface } from 'node:readline/promises';

export async function confirmRun() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'Refusing to start without confirmation in a non-interactive terminal. '
        + 'Pass --yes or set ACP_REVIEW_YES=1 to proceed.',
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Start run? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
