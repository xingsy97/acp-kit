import process from 'node:process';

/**
 * Plain console renderer. Subscribes to engine events and prints them as a
 * scrolling line-based log with compact tool-call details. Bookkeeping lives
 * in the engine; this renderer only formats the event stream.
 */
export function createPlainRenderer() {
  let midLine = false;
  let textColorActive = false;
  let textParagraph = 0;
  let lineHasText = false;

  const ansiCodes = {
    gray: 90,
    yellow: 33,
    green: 32,
    red: 31,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
  };

  const color = (name, text) => {
    if (!process.stdout.isTTY) return text;
    return `\u001b[${ansiCodes[name]}m${text}\u001b[0m`;
  };

  const paragraphPalette = ['white', 'cyan', 'green', 'yellow', 'magenta', 'blue'];
  const paragraphColor = () => paragraphPalette[textParagraph % paragraphPalette.length];
  const resetColor = () => {
    if (process.stdout.isTTY && textColorActive) {
      process.stdout.write('\u001b[0m');
      textColorActive = false;
    }
  };

  const toolColor = (status) => {
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  };

  const toolStatusLabel = (status) => status === 'completed' ? 'done' : status;
  let toolBurstCount = 0;
  let toolBurstHidden = 0;

  const stringifyValue = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) || '';
  };

  const compactWhitespace = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const truncateText = (text, max) => {
    const value = compactWhitespace(text);
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}\u2026`;
  };

  const findField = (value, names, depth = 0) => {
    if (value == null || depth > 4 || typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findField(item, names, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, item] of Object.entries(value)) {
      if (names.includes(key) && (typeof item === 'string' || typeof item === 'number')) return String(item);
    }
    for (const item of Object.values(value)) {
      const found = findField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  };

  const summarizeValue = (value, max = 90) => {
    if (value == null) return '';
    const command = findField(value, ['command', 'cmd', 'shellCommand', 'script']);
    if (command) return truncateText(command, max);
    return truncateText(stringifyValue(value), max);
  };

  const summarizeTool = (event, { includeOutput = false } = {}) => {
    const parts = [`  [tool ${event.tag} ${toolStatusLabel(event.status || 'running')}]`];
    if (event.title) parts.push(event.title);
    const input = summarizeValue(event.input);
    if (input) parts.push(`cmd: ${input}`);
    if (includeOutput) {
      const output = summarizeValue(event.output, 70);
      if (output) parts.push(`out: ${output}`);
      if (event.chars) parts.push(`${event.chars} chars`);
    }
    return parts.join(' ');
  };

  const wrapLine = (text, cols = process.stdout.columns || 80) => {
    const width = Math.max(20, cols - 2);
    if (text.length <= width) return [text];
    const rows = [];
    let rest = text;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      rows.push(rest.slice(0, cut).trimEnd());
      rest = `  ${rest.slice(cut).trimStart()}`;
    }
    if (rest) rows.push(rest);
    return rows;
  };

  const logTool = (status, message) => {
    for (const row of wrapLine(message)) {
      console.log(color(toolColor(status), row));
    }
  };

  const flushToolBurst = () => {
    if (toolBurstHidden > 0) {
      logTool('running', `  [tools] ${toolBurstHidden} additional continuous tool events hidden; use --tui and press t for raw ACP details`);
    }
    toolBurstCount = 0;
    toolBurstHidden = 0;
  };

  const logToolBurst = (status, message) => {
    toolBurstCount += 1;
    if (toolBurstCount <= 3) {
      logTool(status, message);
      return;
    }
    if (toolBurstCount === 4) {
      logTool(status, '  [tools] continuous tool events collapsed after 3 lines');
      return;
    }
    toolBurstHidden += 1;
  };

  const lineFeed = () => {
    if (midLine) {
      resetColor();
      process.stdout.write('\n');
      midLine = false;
      lineHasText = false;
    }
  };

  const writeTextDelta = (delta) => {
    if (!process.stdout.isTTY) {
      process.stdout.write(delta);
      midLine = !delta.endsWith('\n');
      return;
    }

    for (const char of delta) {
      if (char === '\n') {
        resetColor();
        process.stdout.write(char);
        if (!lineHasText) textParagraph += 1;
        lineHasText = false;
        midLine = false;
        continue;
      }

      if (!textColorActive) {
        process.stdout.write(`\u001b[${ansiCodes[paragraphColor()]}m`);
        textColorActive = true;
      }
      process.stdout.write(char);
      if (char.trim() !== '') lineHasText = true;
      midLine = true;
    }
  };

  return {
    /**
     * Wire this renderer to a loop engine. Returns the unsubscribe function.
     */
    attach(engine) {
      return engine.onEvent((event) => {
        switch (event.type) {
          case 'launching':
            flushToolBurst();
            console.log('Launching agents in parallel (this can take a few seconds on cold start)...');
            return;
          case 'roleStatus':
            flushToolBurst();
            console.log(`  [${event.role.toLowerCase()}] ${event.message}`);
            return;
          case 'turnStart':
            flushToolBurst();
            console.log(`\n${'-'.repeat(64)}\nRound ${event.round} - ${event.role}\n${'-'.repeat(64)}`);
            return;
          case 'delta':
            flushToolBurst();
            writeTextDelta(event.delta);
            return;
          case 'toolStart':
            lineFeed();
            logToolBurst('running', summarizeTool(event));
            return;
          case 'toolEnd':
            lineFeed();
            logToolBurst(event.status, summarizeTool(event, { includeOutput: true }));
            return;
          case 'turnCompleted':
            flushToolBurst();
            lineFeed();
            console.log(`  (turn done: ${event.stopReason})`);
            return;
          case 'turnFailed':
            flushToolBurst();
            lineFeed();
            console.log(`  (turn failed: ${event.error})`);
            return;
          case 'turnEnd':
            flushToolBurst();
            lineFeed();
            return;
          case 'result': {
            flushToolBurst();
            const { approved, feedback, maxRounds, cwd } = event.result;
            console.log('\n' + '='.repeat(64));
            if (approved) console.log(`Approved. Files under ${cwd}.`);
            else console.log(`Not approved after ${maxRounds} rounds.\nLast feedback:\n${feedback}`);
            return;
          }
          default:
            return;
        }
      });
    },
  };
}
