import process from 'node:process';
import { createLoopEngine, PaneStatus, Phase } from '../engine.mjs';

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
        + `Install them or rerun without --tui.\nUnderlying error: ${detail}`,
    );
  }

  const { render, Box, Text, useApp, useInput, useStdout } = ink;
  const {
    createElement: h,
    useEffect,
    useState,
    useReducer,
  } = React;

  const engine = createLoopEngine({ config });

  // -- TTY guard -----------------------------------------------------------
  // The TUI requires a real terminal both to draw and to read confirmation;
  // refuse loudly on non-TTY before touching the screen so we never leave
  // half-rendered escape sequences in the user's pipeline output.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      '--tui requires an interactive terminal (stdin and stdout must be TTY).\n'
        + 'Re-run without --tui or attach a TTY.',
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
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });

  // -- helpers -------------------------------------------------------------
  function paneStatusColor(status) {
    if (status === PaneStatus.Running) return 'yellow';
    if (status === PaneStatus.Completed) return 'green';
    if (status === PaneStatus.Failed) return 'red';
    return 'gray';
  }

  function toolStatusColor(status) {
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  }

  function toolStatusLabel(status) {
    return status === 'completed' ? 'done' : status;
  }

  const paragraphPalette = ['white', 'cyan', 'green', 'yellow', 'magenta', 'blue'];
  function paragraphColor(index) {
    return paragraphPalette[index % paragraphPalette.length];
  }

  function line(child, key) {
    return h(Box, { key, height: 1, overflow: 'hidden' }, child);
  }

  function rowText(text, key) {
    return line(h(Text, { wrap: 'truncate-end' }, text), key);
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
    if (items.some((item) => item.status === 'failed' || item.status === 'error')) return 'failed';
    if (items.some((item) => item.status === 'running')) return 'running';
    return items[items.length - 1]?.status || 'completed';
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

  // -- view state (separate from engine state) -----------------------------
  const initialView = {
    selected: null,    // round number currently focused
    follow: true,      // auto-jump to latest round
    focus: 'AUTHOR',   // which pane is active for scrolling
    screen: 'flow',     // flow | trace
    scrollAuthor: 0,   // 0 = bottom; positive = scrolled up by N lines
    scrollReviewer: 0,
    scrollTrace: 0,
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
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        const next = Math.max(0, s[key] + a.delta);
        return { ...s, [key]: next };
      }
      case 'scrollEnd': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        return { ...s, [key]: 0 };
      }
      case 'toggleTrace':
        return { ...s, screen: s.screen === 'trace' ? 'flow' : 'trace', scrollTrace: 0 };
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
      const off = engine.subscribe(() => setTick((t) => (t + 1) | 0));
      return off;
    }, []);

    // Auto-follow: whenever a new round arrives keep the view pinned.
    const state = engine.getState();
    useEffect(() => {
      dispatchView({ type: 'autoFollow', order: state.order });
    }, [state.order.length]);

    // Kick off the run exactly once, but only after the user confirms (or
    // immediately if --yes / ACP_REVIEW_YES skipped the prompt).
    useEffect(() => {
      if (view.awaitingConfirm || view.cancelled) return;
      engine.run()
        .then((r) => { runResult = r; })
        .catch((err) => { runFailure = err; })
        .finally(() => { runDone = true; setTick((t) => (t + 1) | 0); });
    }, [view.awaitingConfirm, view.cancelled]);

    // If user cancels in the confirm overlay, treat the run as done so `q` exits.
    useEffect(() => {
      if (view.cancelled) {
        runDone = true;
        setTick((t) => (t + 1) | 0);
      }
    }, [view.cancelled]);

    useInput((input, key) => {
      // Confirm overlay traps all input until resolved.
      if (view.awaitingConfirm) {
        if (input === 'y' || input === 'Y' || key.return) {
          dispatchView({ type: 'confirm' });
        } else if (input === 'n' || input === 'N' || key.escape || (input === 'q')) {
          dispatchView({ type: 'cancel' });
        }
        return;
      }
      if (key.leftArrow)        dispatchView({ type: 'select', delta: -1, order: state.order });
      else if (key.rightArrow)  dispatchView({ type: 'select', delta: 1, order: state.order });
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
    const idealFooter = (state.phase === Phase.Done || state.phase === Phase.Error) ? 4 : 0;

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
            const summary = `${run.length} continuous tool calls${failed ? ` (${failed} failed)` : ''}`;
            rows.push({ kind: 'tool', status, text: summary });
            run.slice(0, 3).forEach((tool) => {
              const text = `  ${summarizeTool(tool, { compact: true })}`;
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part) => rows.push({ kind: 'tool', status: tool.status || status, text: part }));
            });
            if (run.length > 3) {
              rows.push({ kind: 'tool', status, text: `  ... ${run.length - 3} more; press t for raw ACP details` });
            }
          } else {
            for (const tool of run) {
              const status = tool.status || 'running';
              const text = summarizeTool(tool);
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part) => rows.push({ kind: 'tool', status, text: part }));
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
            Text,
            { wrap: 'truncate-end' },
            h(Text, { bold: true, color }, headerLabel),
            ' ',
            h(Text, { color: paneStatusColor(status) }, status),
          ),
          `${role}-header`,
        ),
        ...visible.map((row, i) => {
          const text = row.text === '' ? ' ' : row.text;
          if (row.kind === 'tool') {
            return line(
              h(Text, { color: toolStatusColor(row.status), wrap: 'truncate-end' }, text),
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

    const mainView = view.screen === 'trace' ? h(TraceView) : split;

    // ---- nav -----------------------------------------------------------
    const navText = total === 0
      ? 'Waiting for first round...'
      : `Round ${selectedRound} (${idx + 1}/${total})`;
    const focusHint = `focus:${view.focus.toLowerCase()}`;
    const wrapHint = view.wrap ? 'wrap:on' : 'wrap:off';
    const followHint = view.follow ? 'follow:on' : 'follow:off';
    const screenHint = view.screen === 'trace' ? 'trace:on' : 'trace:off';
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
        { dimColor: true, wrap: 'truncate-end' },
        `${navText}   \u2190/\u2192 round  \u2191/\u2193 scroll  Tab focus  t trace  w wrap  g latest  ? help  q quit`,
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

    // ---- footer (only when run is done) --------------------------------
    let footer = null;
    if (state.phase === Phase.Done && state.result) {
      footer = h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          paddingX: 1,
          height: footerHeight,
          overflow: 'hidden',
        },
        h(
          Text,
          {
            color: state.result.approved ? 'green' : 'red',
            bold: true,
            wrap: 'truncate-end',
          },
          state.result.approved
            ? `\u2705  APPROVED  \u2705  Files under ${state.result.cwd}.`
            : `Not approved after ${state.result.rounds}/${state.result.maxRounds} rounds.`,
        ),
        h(
          Text,
          { dimColor: true, wrap: 'truncate-end' },
          'Run complete \u2014 \u2190/\u2192 review rounds, q to quit.',
        ),
      );
    } else if (state.phase === Phase.Error) {
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
        h(Text, { dimColor: true, wrap: 'truncate-end' }, 'Press q to quit.'),
      );
    }

    // ---- confirm overlay (first frame, blocks engine.run) -------------
    if (view.awaitingConfirm) {
      const lines = [
        ['cwd:      ', config.cwd],
        ['task:     ', config.task],
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
              { key: i, wrap: 'truncate-end' },
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
          h(Text, { dimColor: true }, 'Press q to quit.'),
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
          h(Text, null, '  \u2190 / \u2192     Move between rounds'),
          h(Text, null, '  \u2191 / \u2193     Scroll focused pane up/down by 1 line'),
          h(Text, null, '  PgUp/PgDn  Scroll focused pane by 10 lines'),
          h(Text, null, '  j / k      Same as down/up arrows'),
          h(Text, null, '  Tab        Switch focused pane (AUTHOR \u2194 REVIEWER)'),
          h(Text, null, '  g          Jump to latest round, re-enable follow'),
          h(Text, null, '  G          Reset scroll to bottom in focused pane'),
          h(Text, null, '  t          Toggle ACP trace view'),
          h(Text, null, '  w          Toggle soft wrap'),
          h(Text, null, '  ?          Toggle this help'),
          h(Text, null, '  q          Quit (only after the run completes)'),
          h(Text, null, ''),
          h(Text, { dimColor: true }, 'Press ? again to dismiss.'),
        ),
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
    leaveAltScreen();
  }

  if (runFailure) throw runFailure;
  if (!runResult) return 1;
  return runResult.approved ? 0 : 1;
}
