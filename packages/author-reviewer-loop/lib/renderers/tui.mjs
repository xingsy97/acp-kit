import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLoopEngine, PaneStatus, Phase } from '../engine.mjs';

const DEFAULT_EDITOR_TIMEOUT_MS = 30 * 60 * 1000;
const ENGINE_RENDER_FRAME_MS = 50;

/**
 * Ink-based TUI renderer.
 *
 * Design principles (the previous implementation violated all three):
 *   1. The TUI must always occupy exactly the visible terminal viewport.
 *      We pin the root <Box> to `stdout.rows` x `stdout.columns` so Ink
 *      never lays out beyond the screen edges.
 *   2. Content must NEVER overflow off-screen. Every container uses
 *      `overflow="hidden"`. Each pane has a fixed height computed from the
 *      remaining viewport budget; long pane content is scrolled internally
 *      via a per-pane scroll offset rather than by growing the layout.
 *   3. The TUI uses the alternate screen buffer (\x1b[?1049h / l) so it
 *      owns the screen for the duration of the run and leaves the user's
 *      scrollback intact when it exits.
 *
 * Lazy-imports `ink` and `react` so the plain CLI does not pay for them.
 * Returns 0 on approval, 1 otherwise.
 */
export async function runTui({ config }) {
  let ink;
  let React;
  try {
    [ink, React] = await Promise.all([import('ink'), import('react')]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Ink TUI mode requires the optional `ink` and `react` packages.\n'
        + `Install them or rerun with --cli.\nUnderlying error: ${detail}`,
    );
  }

  const { render, Box, Text, useApp, useInput, useStdout } = ink;
  const {
    createElement: h,
    useEffect,
    useState,
    useReducer,
  } = React;

  let approvalResolver = null;
  let exitAfterApproval = false;
  config.onApproved = () => new Promise((resolve) => {
    approvalResolver = resolve;
  });

  function resolveApproval(decision) {
    const resolve = approvalResolver;
    approvalResolver = null;
    resolve?.(decision);
  }

  function forceContinueAfterApproval() {
    resolveApproval({
      continue: true,
      feedback: `The reviewer approved, but the user requested another round. Re-check the current task and make any further improvements needed:\n${config.task}`,
    });
  }

  const engine = createLoopEngine({ config });

  // -- TTY guard -----------------------------------------------------------
  // The TUI requires a real terminal both to draw and to read confirmation;
  // refuse loudly on non-TTY before touching the screen so we never leave
  // half-rendered escape sequences in the user's pipeline output.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      '--tui requires an interactive terminal (stdin and stdout must be TTY).\n'
        + 'Re-run with --cli or attach a TTY.',
    );
  }

  // -- alt screen buffer ---------------------------------------------------
  let altScreenActive = false;
  function enterAltScreen() {
    if (!process.stdout.isTTY || altScreenActive) return;
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
    altScreenActive = true;
  }
  function leaveAltScreen() {
    if (!altScreenActive) return;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    altScreenActive = false;
  }
  enterAltScreen();
  const restore = () => leaveAltScreen();
  const handleSigint = () => { restore(); process.exit(130); };
  const handleSigterm = () => { restore(); process.exit(143); };
  process.on('exit', restore);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  // -- helpers -------------------------------------------------------------
  function paneStatusColor(status) {
    if (status === PaneStatus.Running) return 'yellow';
    if (status === PaneStatus.Completed) return 'green';
    if (status === PaneStatus.Failed) return 'red';
    return 'gray';
  }

  function toolStatusColor(status) {
    if (status === 'partial-failed') return '#ffa500';
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  }

  function toolStatusLabel(status) {
    return status === 'completed' ? 'done' : status;
  }

  const paragraphPalette = ['white', 'cyan', 'green', 'yellow', 'blue'];
  function paragraphColor(index) {
    return paragraphPalette[index % paragraphPalette.length];
  }

  function line(child, key) {
    return h(Box, { key, height: 1, overflow: 'hidden' }, child);
  }

  function rowText(text, key) {
    return line(h(Text, { wrap: 'truncate-end' }, text), key);
  }

  function muted(text) {
    return h(Text, { dimColor: true }, text);
  }

  function shortcutLabel(text, color = 'cyan') {
    return h(Text, { color, bold: true }, text);
  }

  function shortcutLine(...parts) {
    return h(Text, { wrap: 'truncate-end' }, ...parts);
  }

  function normalizeDisplayText(text) {
    return text.replace(/([.!?])(?=[A-Z`])/g, '$1 ');
  }

  function stringifyValue(value) {
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
  }

  function compactWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function truncateText(text, max) {
    const value = compactWhitespace(text);
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}\u2026`;
  }

  function findField(value, names, depth = 0) {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findField(item, names, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, item] of Object.entries(value)) {
      if (names.includes(key) && (typeof item === 'string' || typeof item === 'number')) {
        return String(item);
      }
    }
    for (const item of Object.values(value)) {
      const found = findField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  }

  function summarizeValue(value, max = 90) {
    if (value == null) return '';
    const command = findField(value, ['command', 'cmd', 'shellCommand', 'script']);
    if (command) return truncateText(command, max);
    const text = stringifyValue(value);
    return truncateText(text, max);
  }

  function summarizeTool(item, { compact = false } = {}) {
    const status = toolStatusLabel(item.status || 'running');
    const title = item.title || item.name || item.toolCallId || 'tool';
    const input = summarizeValue(item.input, compact ? 44 : 80);
    const output = summarizeValue(item.output, compact ? 36 : 70);
    const parts = [`${item.tag || '#?'} ${status}`, title];
    if (input) parts.push(`cmd: ${input}`);
    if (output) parts.push(`out: ${output}`);
    if (item.chars) parts.push(`${item.chars} chars`);
    return parts.join(' - ');
  }

  function mergedToolStatus(items) {
    const failed = items.filter((item) => item.status === 'failed' || item.status === 'error').length;
    if (failed === items.length) return 'failed';
    if (failed > 0) return 'partial-failed';
    if (items.some((item) => item.status === 'running')) return 'running';
    return items[items.length - 1]?.status || 'completed';
  }

  function formatUsage(usage) {
    const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
    const output = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
    if (input > 0 || output > 0) {
      return `In/Out ${formatTokenCount(input)}/${formatTokenCount(output)} Tk`;
    }
    const used = Number.isFinite(usage?.used) ? usage.used : 0;
    const size = Number.isFinite(usage?.size) ? usage.size : 0;
    if (used > 0 || size > 0) {
      return `Used ${formatTokenCount(used)}/${formatTokenCount(size)} Tk`;
    }
    return 'Tokens --';
  }

  function formatTokenCount(tokens) {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.?0+$/, '')}K`;
    return String(tokens);
  }

  // Soft-wrap one logical line to display rows. Prefer word boundaries; only
  // hard-cut when a single token is wider than the pane.
  function wrapLine(line, cols) {
    if (cols <= 0) return [line];
    if (line.length <= cols) return [line];
    const out = [];
    let rest = line;
    while (rest.length > cols) {
      let cut = rest.lastIndexOf(' ', cols);
      if (cut <= 0) cut = cols;
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
    return out;
  }

  function editorCommand() {
    if (process.platform === 'win32') {
      return { command: process.env.VISUAL || process.env.EDITOR || 'notepad.exe', args: [] };
    }
    return { command: process.env.VISUAL || process.env.EDITOR || 'vi', args: [] };
  }

  function editorTimeoutMs() {
    const parsed = Number.parseInt(process.env.ACP_REVIEW_EDITOR_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EDITOR_TIMEOUT_MS;
  }

  function editTaskText(currentTask) {
    let tempDir;
    let previousRawMode = process.stdin.isRaw;
    let terminalReleased = false;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-task-'));
      const taskFile = path.join(tempDir, 'task.txt');
      fs.writeFileSync(taskFile, currentTask || '', 'utf8');
      const { command, args } = editorCommand();
      const timeout = editorTimeoutMs();
      leaveAltScreen();
      terminalReleased = true;
      previousRawMode = process.stdin.isRaw;
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      const result = spawnSync(command, [...args, taskFile], { stdio: 'inherit', timeout });
      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          throw new Error(`${command} timed out after ${Math.round(timeout / 1000)} seconds.`);
        }
        throw result.error;
      }
      if (result.signal) throw new Error(`${command} exited after signal ${result.signal}.`);
      if (result.status && result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
      return fs.readFileSync(taskFile, 'utf8').trimEnd();
    } finally {
      try {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      } finally {
        if (terminalReleased) {
          if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(previousRawMode));
          enterAltScreen();
        }
      }
    }
  }

  // -- view state (separate from engine state) -----------------------------
  const initialView = {
    selected: null,    // round number currently focused
    follow: true,      // auto-jump to latest round
    focus: 'AUTHOR',   // which pane is active for scrolling
    screen: 'flow',     // flow | trace | tool | taskConfirm
    selectedTool: null, // { round, role, toolCallId } used by the tool detail view
    pendingTask: null,
    editFromConfirm: false,
    editError: null,
    scrollAuthor: 0,   // 0 = bottom; positive = scrolled up by N lines
    scrollReviewer: 0,
    scrollTrace: 0,
    scrollTool: 0,
    scrollConfirm: 0,
    wrap: true,        // soft wrap pane content
    showHelp: false,
    awaitingConfirm: !config.skipConfirm, // show confirm overlay first
    cancelled: false,  // user pressed n/Esc on the confirm overlay
  };
  function viewReducer(s, a) {
    switch (a.type) {
      case 'confirm':
        return { ...s, awaitingConfirm: false };
      case 'cancel':
        return { ...s, awaitingConfirm: false, cancelled: true };
      case 'select': {
        if (a.order.length === 0) return s;
        const cur = s.selected ?? a.order[a.order.length - 1];
        const idx = Math.max(0, a.order.indexOf(cur));
        const next = Math.max(0, Math.min(a.order.length - 1, idx + a.delta));
        const sel = a.order[next];
        return {
          ...s,
          selected: sel,
          follow: sel === a.order[a.order.length - 1],
          scrollAuthor: 0,
          scrollReviewer: 0,
        };
      }
      case 'jumpLatest':
        if (a.order.length === 0) return s;
        return { ...s, selected: a.order[a.order.length - 1], follow: true, scrollAuthor: 0, scrollReviewer: 0 };
      case 'autoFollow':
        if (!s.follow || a.order.length === 0) return s;
        return { ...s, selected: a.order[a.order.length - 1] };
      case 'scroll': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        const next = Math.max(0, s[key] + a.delta);
        return { ...s, [key]: next };
      }
      case 'scrollEnd': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        return { ...s, [key]: 0 };
      }
      case 'scrollConfirm':
        return { ...s, scrollConfirm: Math.max(0, s.scrollConfirm + a.delta) };
      case 'scrollConfirmTop':
        return { ...s, scrollConfirm: 0 };
      case 'toggleTrace':
        return { ...s, screen: s.screen === 'trace' ? 'flow' : 'trace', scrollTrace: 0 };
      case 'selectTool':
        return { ...s, selectedTool: a.tool };
      case 'openTool':
        return a.tool ? { ...s, selectedTool: a.tool, screen: 'tool', scrollTool: 0 } : s;
      case 'closeTool':
        return { ...s, screen: 'flow' };
      case 'taskEdited':
        return {
          ...s,
          screen: 'taskConfirm',
          pendingTask: a.task,
          editFromConfirm: Boolean(a.fromConfirm),
          editError: null,
          awaitingConfirm: false,
          scrollConfirm: 0,
        };
      case 'taskEditFailed':
        return { ...s, editError: a.error };
      case 'confirmTask':
        return { ...s, screen: 'flow', pendingTask: null, editFromConfirm: false, editError: null };
      case 'discardTask':
        return { ...s, screen: 'flow', pendingTask: null, awaitingConfirm: s.editFromConfirm, editFromConfirm: false, editError: null };
      case 'toggleFocus':
        return { ...s, focus: s.focus === 'AUTHOR' ? 'REVIEWER' : 'AUTHOR' };
      case 'toggleWrap':
        return { ...s, wrap: !s.wrap };
      case 'toggleHelp':
        return { ...s, showHelp: !s.showHelp };
      default:
        return s;
    }
  }

  // -- the App component ---------------------------------------------------
  let runDone = false;
  let runStarted = false;
  let runFailure = null;
  let runResult = null;

  function App() {
    const app = useApp();
    const { stdout } = useStdout();

    // Mirror engine state into React state so we re-render on each event.
    const [, setTick] = useState(0);
    const [view, dispatchView] = useReducer(viewReducer, initialView);
    const [size, setSize] = useState({
      rows: stdout?.rows || 24,
      cols: stdout?.columns || 80,
    });

    useEffect(() => {
      const onResize = () => setSize({ rows: stdout.rows, cols: stdout.columns });
      stdout?.on?.('resize', onResize);
      return () => stdout?.off?.('resize', onResize);
    }, [stdout]);

    useEffect(() => {
      let timeout = null;
      let pending = false;
      const flush = () => {
        timeout = null;
        if (!pending) return;
        pending = false;
        setTick((t) => (t + 1) | 0);
      };
      const schedule = (action) => {
        pending = true;
        if (action?.type === 'result' || action?.type === 'error') {
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          flush();
          return;
        }
        if (!timeout) timeout = setTimeout(flush, ENGINE_RENDER_FRAME_MS);
      };
      const off = engine.subscribe((_state, action) => schedule(action));
      return () => {
        off();
        if (timeout) clearTimeout(timeout);
      };
    }, []);

    // Auto-follow: whenever a new round arrives keep the view pinned.
    const state = engine.getState();
    useEffect(() => {
      dispatchView({ type: 'autoFollow', order: state.order });
    }, [state.order.length]);

    // Kick off the run exactly once, but only after the user confirms (or
    // immediately if --yes / ACP_REVIEW_YES skipped the prompt).
    useEffect(() => {
      if (runStarted || view.awaitingConfirm || view.cancelled || view.screen === 'taskConfirm') return;
      runStarted = true;
      engine.run()
        .then((r) => { runResult = r; })
        .catch((err) => { runFailure = err; })
        .finally(() => {
          runDone = true;
          setTick((t) => (t + 1) | 0);
          if (exitAfterApproval) {
            leaveAltScreen();
            app.exit();
          }
        });
    }, [view.awaitingConfirm, view.cancelled, view.screen]);

    // If user cancels in the confirm overlay, treat the run as done so `q` exits.
    useEffect(() => {
      if (view.cancelled) {
        runDone = true;
        setTick((t) => (t + 1) | 0);
      }
    }, [view.cancelled]);

    useInput((input, key) => {
      const approvalPending = Boolean(approvalResolver && state.phase === Phase.Done && state.result?.approved);
      const openTaskEditor = () => {
        try {
          dispatchView({ type: 'taskEdited', task: editTaskText(config.task), fromConfirm: view.awaitingConfirm });
          setTick((t) => (t + 1) | 0);
        } catch (error) {
          dispatchView({ type: 'taskEditFailed', error: error instanceof Error ? error.message : String(error) });
        }
      };

      // Confirm overlay traps all input until resolved.
      if (view.awaitingConfirm) {
        if (input === 'y' || input === 'Y' || key.return) {
          dispatchView({ type: 'confirm' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        } else if (input === 'n' || input === 'N' || key.escape || (input === 'q')) {
          dispatchView({ type: 'cancel' });
        }
        return;
      }

      if (view.screen === 'taskConfirm') {
        if (key.upArrow || input === 'k') {
          dispatchView({ type: 'scrollConfirm', delta: -1 });
        } else if (key.downArrow || input === 'j') {
          dispatchView({ type: 'scrollConfirm', delta: 1 });
        } else if (key.pageUp) {
          dispatchView({ type: 'scrollConfirm', delta: -10 });
        } else if (key.pageDown) {
          dispatchView({ type: 'scrollConfirm', delta: 10 });
        } else if (input === 'g' || input === 'G') {
          dispatchView({ type: 'scrollConfirmTop' });
        } else if (key.return || input === 'y' || input === 'Y') {
          const nextTask = view.pendingTask ?? config.task;
          const changed = nextTask !== config.task;
          config.task = nextTask;
          config.taskSource = { kind: 'edited' };
          if (approvalPending) {
            resolveApproval(changed
              ? {
                continue: true,
                feedback: `The task was edited after approval. Continue with the updated task:\n${config.task}`,
              }
              : { continue: false });
          }
          dispatchView({ type: 'confirmTask' });
          setTick((t) => (t + 1) | 0);
        } else if (key.escape || input === 'n' || input === 'N' || input === 'q') {
          dispatchView({ type: 'discardTask' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        }
        return;
      }

      if (approvalPending && (input === 'f' || input === 'F')) {
        forceContinueAfterApproval();
      } else if (approvalPending && (key.return || input === 'q')) {
        exitAfterApproval = input === 'q';
        resolveApproval({ continue: false });
      } else if (key.leftArrow) dispatchView({ type: 'select', delta: -1, order: state.order });
      else if (key.rightArrow)  dispatchView({ type: 'select', delta: 1, order: state.order });
      else if (view.screen === 'tool' && (key.escape || input === 'q')) dispatchView({ type: 'closeTool' });
      else if (input === 'g')   dispatchView({ type: 'jumpLatest', order: state.order });
      else if (input === 'G')   dispatchView({ type: 'scrollEnd' });
      else if (key.upArrow)     dispatchView({ type: 'scroll', delta: 1 });
      else if (key.downArrow)   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.pageUp)      dispatchView({ type: 'scroll', delta: 10 });
      else if (key.pageDown)    dispatchView({ type: 'scroll', delta: -10 });
      else if (input === 'k')   dispatchView({ type: 'scroll', delta: 1 });
      else if (input === 'j')   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.tab || input === '\t') dispatchView({ type: 'toggleFocus' });
      else if (input === 't')   dispatchView({ type: 'toggleTrace' });
      else if (input === '[')   dispatchView({ type: 'selectTool', tool: moveToolSelection(-1) });
      else if (input === ']')   dispatchView({ type: 'selectTool', tool: moveToolSelection(1) });
      else if (key.return || input === 'd') dispatchView({ type: 'openTool', tool: currentToolSelection() });
      else if (input === 'e' || input === 'E') openTaskEditor();
      else if (input === 'w')   dispatchView({ type: 'toggleWrap' });
      else if (input === '?')   dispatchView({ type: 'toggleHelp' });
      else if (input === 'q' && runDone) {
        leaveAltScreen();
        app.exit();
      }
    });

    // ---- layout budget -------------------------------------------------
    // The TUI must occupy EXACTLY size.rows (including the pathological
    // case of size.rows in {0, 1, 2, 3, ...}). Layout vertically:
    //
    //   header (headerHeight) + panes (paneOuter) + nav (navHeight) + footer (footerHeight) === size.rows
    //
    // No spacer rows are rendered, so none are subtracted. We allocate
    // strictly top-down, giving each component what's *left*, with no
    // minimum floors -- that way on a 1-row terminal we render only the
    // header (truncated to 1 row), and on 0 rows we render nothing. The
    // invariant header + pane + nav + footer === size.rows always holds.
    const totalRows = Math.max(0, size.rows);
    const idealHeader = 7;        // title + cwd/task/rounds + combined status + border
    const idealNav = 3;           // 1 line + 2 border
    const idealFooter = state.phase === Phase.Error ? 4 : 0;

    // Header is the highest-priority chunk; give it up to its ideal but
    // never more than the total. Nav comes next, then footer, then panes
    // get every remaining row.
    const headerHeight = Math.min(idealHeader, totalRows);
    let remaining = totalRows - headerHeight;
    const navHeight = Math.min(idealNav, remaining);
    remaining -= navHeight;
    const footerHeight = Math.min(idealFooter, remaining);
    remaining -= footerHeight;
    const paneOuter = remaining; // exactly fills the rest, may be 0

    // Pane internals: 2 border + 1 header line + status, etc.
    // Reserve up to 6 for chrome but never more than what the pane has.
    const paneInner = Math.max(0, paneOuter - Math.min(6, paneOuter));

    // Content width: each pane gets half of (cols - 1 spacer column),
    // minus border+padding (4) per pane.
    const paneCols = Math.max(1, Math.floor((Math.max(1, size.cols) - 1) / 2) - 4);
    const headerCols = Math.max(1, size.cols - 4);

    // ---- header --------------------------------------------------------
    const taskRows = wrapLine(`task:     ${config.task}`, headerCols).slice(0, 2);
    const statusLine = h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { color: 'cyan', bold: true }, 'AUTHOR'),
      h(Text, { color: 'cyan' }, `: ${config.authorSettings.agent.displayName}`),
      h(Text, { dimColor: true }, ` (${config.authorSettings.model || 'default'}) `),
      h(Text, { color: paneStatusColor(roleStatusToPaneStatus(state.statuses.AUTHOR)) }, state.statuses.AUTHOR),
      h(Text, { dimColor: true }, ' | '),
      h(Text, { color: 'magenta', bold: true }, 'REVIEWER'),
      h(Text, { color: 'magenta' }, `: ${config.reviewerSettings.agent.displayName}`),
      h(Text, { dimColor: true }, ` (${config.reviewerSettings.model || 'default'}) `),
      h(Text, { color: paneStatusColor(roleStatusToPaneStatus(state.statuses.REVIEWER)) }, state.statuses.REVIEWER),
    );
    const header = h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        height: headerHeight,
        overflow: 'hidden',
      },
      line(h(Text, { bold: true, color: 'cyan' }, 'ACP Author/Reviewer Loop'), 'title'),
      line(h(Text, { dimColor: true, wrap: 'truncate-end' }, `cwd:      ${config.cwd}`), 'cwd'),
      ...taskRows.map((row, i) => line(h(Text, { dimColor: true, wrap: 'truncate-end' }, row), `task-${i}`)),
      line(h(Text, { dimColor: true, wrap: 'truncate-end' }, `rounds:   max ${config.maxRounds}`), 'rounds'),
      line(statusLine, 'status'),
    );

    // ---- panes ---------------------------------------------------------
    const selectedRound = view.selected ?? state.order[state.order.length - 1] ?? null;
    const round = selectedRound != null ? state.rounds.get(selectedRound) : null;
    const total = state.order.length;
    const idx = selectedRound == null ? -1 : state.order.indexOf(selectedRound);

    function toolsForSelection() {
      const pane = view.focus === 'AUTHOR' ? round?.AUTHOR : round?.REVIEWER;
      return pane?.tools ?? [];
    }

    function currentToolSelection() {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const selected = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.find((tool) => tool.id === view.selectedTool.toolCallId)
        : null;
      const tool = selected ?? tools[tools.length - 1];
      return { round: selectedRound, role: view.focus, toolCallId: tool.id };
    }

    function moveToolSelection(delta) {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const current = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.findIndex((tool) => tool.id === view.selectedTool.toolCallId)
        : -1;
      const base = current >= 0 ? current : (delta < 0 ? tools.length : -1);
      const next = Math.max(0, Math.min(tools.length - 1, base + delta));
      return { round: selectedRound, role: view.focus, toolCallId: tools[next].id };
    }

    function roleStatusToPaneStatus(status) {
      if (status === 'ready') return PaneStatus.Completed;
      if (String(status).startsWith('launching') || String(status).startsWith('session ready')) {
        return PaneStatus.Running;
      }
      return PaneStatus.Pending;
    }

    function visibleFlowRows(pane, width) {
      if (!pane) return [];
      const rows = [];
      let paragraph = 0;
      let paragraphHasText = false;
      const flow = pane.flow?.length
        ? pane.flow
        : [{ id: 'snapshot-text', kind: 'text', text: [...pane.lines, pane.current].join('\n') }];
      for (let index = 0; index < flow.length; index += 1) {
        const item = flow[index];
        if (item.kind === 'tool') {
          const run = [item];
          while (flow[index + 1]?.kind === 'tool') {
            run.push(flow[index + 1]);
            index += 1;
          }
          if (run.length > 3) {
            const status = mergedToolStatus(run);
            const failed = run.filter((tool) => tool.status === 'failed' || tool.status === 'error').length;
            const succeeded = run.filter((tool) => ['completed', 'done', 'success'].includes(tool.status)).length;
            const summary = `${run.length} Tool Call (${succeeded} Succ, ${failed} Fail)`;
            rows.push({ kind: 'tool', status, text: summary });
            run.slice(0, 3).forEach((tool) => {
              const text = `  ${summarizeTool(tool, { compact: true })}`;
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part) => rows.push({ kind: 'tool', status: tool.status || status, text: part, toolCallId: tool.toolCallId }));
            });
            if (run.length > 3) {
              rows.push({ kind: 'tool', status, text: `  ... ${run.length - 3} more; press [/] then Enter for full tool details` });
            }
          } else {
            for (const tool of run) {
              const status = tool.status || 'running';
              const text = summarizeTool(tool);
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part) => rows.push({ kind: 'tool', status, text: part, toolCallId: tool.toolCallId }));
            }
          }
          continue;
        }
        const normalized = normalizeDisplayText(item.text || '');
        const logical = normalized.split('\n');
        logical.forEach((part, i) => {
          const isCursorLine = pane.status === PaneStatus.Running
            && i === logical.length - 1
            && item === flow[flow.length - 1];
          const value = isCursorLine ? `${part}\u258F` : part;
          const parts = view.wrap ? (value === '' ? [''] : wrapLine(value, width)) : [value];
          parts.forEach((text) => rows.push({ kind: 'text', text, paragraph }));

          if (part.trim() === '' && i < logical.length - 1) {
            if (paragraphHasText) {
              paragraph += 1;
              paragraphHasText = false;
            }
          } else if (part.trim() !== '') {
            paragraphHasText = true;
          }
        });
      }
      return rows;
    }

    function formatTraceRows(item) {
      const { role, entry } = item;
      if (entry.kind !== 'wire') return [];
      const prefix = `${new Date(entry.at).toLocaleTimeString()} ${role} ${entry.direction}`;
      const method = entry.method ? ` ${entry.method}` : '';
      const id = entry.id !== undefined ? ` #${entry.id}` : '';
      const header = `${prefix}${method}${id}`;
      const body = stringifyValue(entry.frame);
      if (!body) return [header];
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        return [header, ...pretty.split('\n').map((line) => `  ${line}`)];
      } catch {
        return [header, `  ${body}`];
      }
    }

    function Pane({ role, color, pane, active }) {
      const status = pane?.status ?? PaneStatus.Pending;
      const chrome = (pane?.stopReason ? 1 : 0)
        + (pane?.error ? 1 : 0);
      // Never let textBudget exceed what the pane actually has room for; if
      // the terminal is so small there's no room left after chrome, drop
      // text entirely (overflow:hidden on the pane keeps us inside bounds).
      const textBudget = Math.max(0, paneInner - chrome);
      const scroll = role === 'AUTHOR' ? view.scrollAuthor : view.scrollReviewer;

      let visible;
      if (textBudget === 0) {
        visible = [];
      } else if (!pane || ((pane.flow?.length ?? 0) === 0 && pane.lines.length === 0 && !pane.current)) {
        visible = [{ kind: 'text', text: '(no output yet)' }];
        while (visible.length < textBudget) visible.push({ kind: 'text', text: '' });
      } else {
        const expanded = visibleFlowRows(pane, paneCols);
        // Scroll: 0 means pin to bottom (last `textBudget` lines visible).
        const end = Math.max(textBudget, expanded.length - scroll);
        const start = Math.max(0, end - textBudget);
        visible = expanded.slice(start, end);
      }

      const headerLabel = `${role} \u2014 Round ${selectedRound ?? '-'}`;
      const focused = active && view.focus === role;
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: focused ? color : 'gray',
          paddingX: 1,
          flexGrow: 1,
          flexBasis: 0,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          h(
            Box,
            { justifyContent: 'space-between', width: '100%' },
            h(
              Text,
              { wrap: 'truncate-end' },
              h(Text, { bold: true, color }, headerLabel),
              ' ',
              h(Text, { color: paneStatusColor(status) }, status),
            ),
            h(Text, { dimColor: true, wrap: 'truncate-end' }, formatUsage(pane?.usage)),
          ),
          `${role}-header`,
        ),
        ...visible.map((row, i) => {
          const text = row.text === '' ? ' ' : row.text;
          if (row.kind === 'tool') {
            const selected = view.selectedTool?.round === selectedRound
              && view.selectedTool?.role === role
              && view.selectedTool?.toolCallId === row.toolCallId;
            return line(
              h(Text, { color: toolStatusColor(row.status), inverse: selected, wrap: 'truncate-end' }, text),
              `l${i}`,
            );
          }
          return line(
            h(Text, { color: paragraphColor(row.paragraph ?? 0), wrap: 'truncate-end' }, text),
            `l${i}`,
          );
        }),
        pane?.stopReason
          ? line(h(Text, { dimColor: true, wrap: 'truncate-end' }, `done: ${pane.stopReason}`), `${role}-done`)
          : null,
        pane?.error
          ? line(h(Text, { color: 'red', wrap: 'truncate-end' }, `error: ${pane.error}`), `${role}-error`)
          : null,
      );
    }

    const split = h(
      Box,
      { flexDirection: 'row', height: paneOuter, overflow: 'hidden' },
      h(Pane, { role: 'AUTHOR', color: 'cyan', pane: round?.AUTHOR, active: true }),
      h(Box, { width: 1 }),
      h(Pane, { role: 'REVIEWER', color: 'magenta', pane: round?.REVIEWER, active: true }),
    );

    function TraceView() {
      const traceRows = state.trace
        .flatMap(formatTraceRows)
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, traceRows.length - view.scrollTrace);
      const start = Math.max(0, end - bodyBudget);
      const visible = traceRows.length === 0
        ? ['No ACP wire messages captured yet.']
        : traceRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(h(Text, { bold: true, color: 'yellow' }, 'ACP Trace - raw redacted wire messages'), 'trace-header'),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `trace-${i}`)),
      );
    }

    function selectedToolRecord() {
      const selection = view.selectedTool;
      if (!selection) return null;
      const selected = state.rounds.get(selection.round)?.[selection.role];
      const tool = selected?.tools?.find((item) => item.id === selection.toolCallId);
      return tool ? { selection, tool } : null;
    }

    function formatToolDetailsRows() {
      const record = selectedToolRecord();
      if (!record) {
        return ['No tool call selected. Press [ or ] in the flow view to select one.'];
      }
      const { selection, tool } = record;
      const rows = [
        `${selection.role} Round ${selection.round} ${tool.tag || ''} ${toolStatusLabel(tool.status || 'running')}`.trim(),
        `id: ${tool.id}`,
        `name: ${tool.name || '(unknown)'}`,
        `title: ${tool.title || '(untitled)'}`,
        `status: ${tool.status || 'running'}`,
        `chars: ${tool.chars ?? 0}`,
        '',
        'input:',
        ...prettyValue(tool.input).map((line) => `  ${line}`),
        '',
        'output:',
        ...prettyValue(tool.output).map((line) => `  ${line}`),
      ];
      return rows;
    }

    function prettyValue(value) {
      if (value == null) return ['(empty)'];
      if (typeof value === 'string') return value.split('\n');
      try {
        return JSON.stringify(value, null, 2).split('\n');
      } catch {
        return [stringifyValue(value)];
      }
    }

    function ToolView() {
      const detailRows = formatToolDetailsRows()
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, detailRows.length - view.scrollTool);
      const start = Math.max(0, end - bodyBudget);
      const visible = detailRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: '#ffa500',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: '#ffa500' }, 'Tool Call Details'),
            muted(' - '),
            shortcutLabel('[/]'),
            muted(' select, '),
            shortcutLabel('Esc/q'),
            muted(' back'),
          ),
          'tool-header',
        ),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `tool-${i}`)),
      );
    }

    const mainView = view.screen === 'trace' ? h(TraceView) : view.screen === 'tool' ? h(ToolView) : split;

    // ---- nav -----------------------------------------------------------
    const navText = total === 0
      ? 'Waiting for first round...'
      : `Round ${selectedRound} (${idx + 1}/${total})`;
    const focusHint = `focus:${view.focus.toLowerCase()}`;
    const wrapHint = view.wrap ? 'wrap:on' : 'wrap:off';
    const followHint = view.follow ? 'follow:on' : 'follow:off';
    const screenHint = view.screen === 'trace' ? 'trace:on' : view.screen === 'tool' ? 'tool:detail' : 'trace:off';
    const resultHint = state.phase === Phase.Done && state.result
      ? state.result.approved
        ? shortcutLine(
          h(Text, { color: 'green', bold: true }, 'APPROVED'),
          muted(' - '),
          shortcutLabel('f'),
          muted(' force continue, '),
          shortcutLabel('e'),
          muted(' edit/resume, '),
          shortcutLabel('Enter'),
          muted(' accept, '),
          shortcutLabel('q'),
          muted(' accept+quit'),
        )
        : shortcutLine(
          muted(`Not approved after ${state.result.rounds}/${state.result.maxRounds}; `),
          shortcutLabel('q'),
          muted(' quit'),
        )
      : null;
    const nav = h(
      Box,
      {
        borderStyle: 'round',
        paddingX: 1,
        height: navHeight,
        overflow: 'hidden',
      },
      h(
        Text,
        { wrap: 'truncate-end' },
        resultHint || muted(navText),
        muted('   '),
        shortcutLabel('\u2190/\u2192'),
        muted(' round  '),
        shortcutLabel('\u2191/\u2193'),
        muted(' scroll  '),
        shortcutLabel('Tab'),
        muted(' focus  '),
        shortcutLabel('[/]'),
        muted(' tool  '),
        shortcutLabel('Enter'),
        muted(' detail  '),
        shortcutLabel('e'),
        muted(' edit  '),
        shortcutLabel('t'),
        muted(' trace  '),
        shortcutLabel('w'),
        muted(' wrap  '),
        shortcutLabel('g'),
        muted(' latest  '),
        shortcutLabel('?'),
        muted(' help  '),
        shortcutLabel('q'),
        muted(' quit'),
        '   ',
        h(Text, { color: view.follow ? 'green' : 'yellow' }, followHint),
        ' ',
        h(Text, { color: 'cyan' }, focusHint),
        ' ',
        h(Text, { color: view.screen === 'trace' ? 'yellow' : 'gray' }, screenHint),
        ' ',
        h(Text, { color: view.wrap ? 'green' : 'gray' }, wrapHint),
      ),
    );

    // ---- footer (only for errors; final status stays in nav to avoid layout jumps)
    let footer = null;
    if (state.phase === Phase.Error) {
      footer = h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          paddingX: 1,
          height: footerHeight,
          overflow: 'hidden',
        },
        h(Text, { color: 'red', wrap: 'truncate-end' }, state.error || 'error'),
        shortcutLine(muted('Press '), shortcutLabel('q'), muted(' to quit.')),
      );
    }

    // ---- task edit confirmation overlay -------------------------------
    if (view.screen === 'taskConfirm') {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(view.pendingTask || '(empty)', confirmCols);
      const bodyBudget = Math.max(0, size.rows - 8);
      const maxStart = Math.max(0, taskLines.length - bodyBudget);
      const start = Math.min(view.scrollConfirm, maxStart);
      const visibleLines = bodyBudget > 0 ? taskLines.slice(start, start + bodyBudget) : [];
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'yellow',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'yellow' }, 'Confirm updated task'),
          h(Text, null, ''),
          ...visibleLines.map((row, i) =>
            h(Text, { key: `task-confirm-${start}-${i}`, wrap: 'wrap' }, start + i === 0 ? 'task:     ' : '          ', row),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' apply   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit again   ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' discard   ',
            shortcutLabel('\u2191/\u2193'),
            ' scroll',
          ),
        ),
      );
    }

    // ---- confirm overlay (first frame, blocks engine.run) -------------
    if (view.awaitingConfirm) {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(config.task || '(empty)', confirmCols);
      const lines = [
        ['cwd:      ', config.cwd],
        ['task src: ', config.taskSource?.kind === 'file' ? config.taskSource.path : '(inline text)'],
        ['task:     ', taskLines[0] ?? ''],
        ...taskLines.slice(1).map((row) => ['          ', row]),
        ['author:   ', `${config.authorSettings.agent.displayName} (${config.authorSettings.agent.id})`],
        ['          model: ', config.authorSettings.model || '(agent default)'],
        ['reviewer: ', `${config.reviewerSettings.agent.displayName} (${config.reviewerSettings.agent.id})`],
        ['          model: ', config.reviewerSettings.model || '(agent default)'],
        ['rounds:   ', `max ${config.maxRounds}`],
        ['trace:    ', config.trace ? 'enabled' : 'disabled'],
      ];
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Start author/reviewer loop?'),
          h(Text, null, ''),
          ...lines.map((row, i) =>
            h(
              Text,
              { key: i, wrap: 'wrap' },
              h(Text, { dimColor: true }, row[0]),
              row[1],
            ),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'y'),
            ' / ',
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' to start   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit task   ',
            h(Text, { color: 'red', bold: true }, 'n'),
            ' / ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' to cancel',
          ),
          h(
            Text,
            { dimColor: true },
            'Tip: pass --yes (or set ACP_REVIEW_YES=1) to skip this prompt.',
          ),
        ),
      );
    }

    // ---- cancelled overlay --------------------------------------------
    if (view.cancelled) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'red',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { color: 'red', bold: true }, 'Cancelled.'),
          shortcutLine(muted('Press '), shortcutLabel('q'), muted(' to quit.')),
        ),
      );
    }

    // ---- help overlay --------------------------------------------------
    if (view.showHelp) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Keybindings'),
          h(Text, null, ''),
          keyBindingLine('\u2190 / \u2192', 'Move between rounds'),
          keyBindingLine('\u2191 / \u2193', 'Scroll focused pane up/down by 1 line'),
          keyBindingLine('PgUp/PgDn', 'Scroll focused pane by 10 lines'),
          keyBindingLine('j / k', 'Same as down/up arrows'),
          keyBindingLine('Tab', 'Switch focused pane (AUTHOR \u2194 REVIEWER)'),
          keyBindingLine('g', 'Jump to latest round, re-enable follow'),
          keyBindingLine('G', 'Reset scroll to bottom in focused pane'),
          keyBindingLine('[ / ]', 'Select previous/next tool call in focused pane'),
          keyBindingLine('Enter / d', 'Open selected tool call details'),
          keyBindingLine('Esc / q', 'Return from tool detail view'),
          keyBindingLine('t', 'Toggle ACP trace view'),
          keyBindingLine('w', 'Toggle soft wrap'),
          keyBindingLine('?', 'Toggle this help'),
          keyBindingLine('f', 'Force another round after reviewer approval'),
          keyBindingLine('q', 'Quit (only after the run completes)'),
          h(Text, null, ''),
          shortcutLine(muted('Press '), shortcutLabel('?'), muted(' again to dismiss.')),
        ),
      );
    }

    function keyBindingLine(keys, description) {
      const padding = ' '.repeat(Math.max(1, 12 - keys.length));
      return shortcutLine(
        muted('  '),
        shortcutLabel(keys),
        muted(`${padding}${description}`),
      );
    }

    return h(
      Box,
      {
        flexDirection: 'column',
        width: size.cols,
        height: size.rows,
        overflow: 'hidden',
      },
      header,
      mainView,
      nav,
      footer,
    );
  }

  // Disable Ink's own scrollback growth: we render in alt-screen, fixed size.
  const inkApp = render(h(App), {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  try {
    await inkApp.waitUntilExit();
  } finally {
    process.off('exit', restore);
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    leaveAltScreen();
  }

  if (runFailure) throw runFailure;
  if (!runResult) return 1;
  return runResult.approved ? 0 : 1;
}
