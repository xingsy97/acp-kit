import { describe, expect, it } from 'vitest';
import { PaneStatus, Phase } from '../lib/engine.mjs';
import {
  formatTuiAvailabilityLabel,
  formatTuiDashboardTitle,
  formatTuiEmptyState,
  formatTuiFinishSummary,
  formatTuiPaneHeadline,
  formatTuiPaneSummary,
  formatTuiPaneStatusLine,
  formatTuiPreferenceStatus,
  formatTuiPlanSummary,
  formatTuiTerminalTitle,
  formatTuiUsageLabel,
  renderTaskPreviewRows,
  renderFixedTaskPreviewRows,
} from '../lib/renderers/tui.mjs';

describe('author-reviewer-loop TUI formatting helpers', () => {
  it('summarizes run status in the dashboard header across lifecycle states', () => {
    expect(formatTuiDashboardTitle({
      phase: Phase.Launching,
      result: null,
      selectedRound: null,
      totalRounds: 0,
      maxRounds: 4,
    })).toBe('• ACP Author/Reviewer Loop · Launching · Standing by for round 1');

    expect(formatTuiDashboardTitle({
      phase: Phase.Done,
      result: { approved: true },
      selectedRound: 2,
      totalRounds: 2,
      maxRounds: 5,
    })).toBe('• ACP Author/Reviewer Loop · Approved · Round 2/5');

    expect(formatTuiDashboardTitle({
      phase: Phase.Error,
      result: null,
      selectedRound: 1,
      totalRounds: 1,
      maxRounds: 3,
    })).toBe('• ACP Author/Reviewer Loop · Error · Round 1/3');
  });

  it('keeps long task previews bounded and preserves the full-task hint', () => {
    const preview = renderFixedTaskPreviewRows(
      'Investigate an extremely long task with many nested details and failure cases '.repeat(8),
      38,
      { maxRows: 2 },
    );

    expect(preview.rows).toHaveLength(2);
    expect(preview.truncated).toBe(true);
    expect(preview.rows[1]).toContain('[v view full task, e edit]');
  });

  it('handles empty, short, and degenerate-width task previews without losing the task affordance', () => {
    expect(renderTaskPreviewRows(undefined, 40)).toEqual({
      rows: ['task:     (empty)'],
      truncated: false,
    });

    expect(renderTaskPreviewRows('short task', 40)).toEqual({
      rows: ['task:     short task'],
      truncated: false,
    });

    const zeroWidth = renderTaskPreviewRows('', 0, { maxRows: 2 });
    expect(zeroWidth.truncated).toBe(true);
    expect(zeroWidth.rows).toHaveLength(2);
    expect(zeroWidth.rows[1]).toContain('[v view full task, e edit]');

    const oneColumn = renderTaskPreviewRows('a', 1, { maxRows: 2 });
    expect(oneColumn.truncated).toBe(true);
    expect(oneColumn.rows).toHaveLength(2);
  });

  it('renders compact pane headlines without noisy counts', () => {
    expect(formatTuiPaneHeadline({
      role: 'AUTHOR',
      round: 2,
      status: PaneStatus.Running,
      agent: 'Copilot',
      model: 'gpt-5.5',
    })).toBe('AUTHOR · Round 2 · ▶ Running · Copilot (gpt-5.5)');
  });

  it('sanitizes blank role labels and startup availability copy for professional presentation', () => {
    expect(formatTuiPaneHeadline({
      role: 'REVIEWER',
      round: 9,
      status: PaneStatus.Completed,
      agent: ' \n ',
      model: ' ',
    })).toBe('REVIEWER · Round 9 · ✓ Ready · (choose) (default)');

    expect(formatTuiAvailabilityLabel({ status: 'ready' })).toBe('Ready');
    expect(formatTuiAvailabilityLabel({ status: 'auto' })).toBe('Via npx');
    expect(formatTuiAvailabilityLabel({ status: 'weird' })).toBe('Unavailable');
  });

  it('keeps plan and pane summaries stable for contradictory or malformed plan entries', () => {
    const entries = [
      { content: 'Harden restart recovery', status: 'completed' },
      null,
      { content: 'Resolve contradictory reviewer guidance', status: 'in_progress' },
      { content: 'Handle malformed adapter output', status: 'failed' },
    ];

    expect(formatTuiPlanSummary(entries)).toBe('Plan 1/4 ✓·→! · working: Resolve contradictory reviewer guidance');
    expect(formatTuiPaneStatusLine({
      pane: {
        tools: [{ id: 't1' }, { id: 't2' }],
        reasoning: { blocks: [{ id: 'r1' }] },
        chars: 8192,
      },
      plan: { entries },
    })).toEqual({
      text: 'Plan 1/4 ✓·→! · working: Resolve contradictory reviewer guidance',
      color: 'cyan',
      dim: false,
    });
  });

  it('truncates oversized plan and empty-state guidance before it can flood narrow panes', () => {
    const longInstruction = 'Recover after contradictory reviewer guidance and malformed LLM output without losing the restarted session state '.repeat(2);
    const entries = [{ content: longInstruction, status: 'in_progress' }];
    const planSummary = formatTuiPlanSummary(entries);
    const emptyState = formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Running,
      selectedRound: 4,
      plan: { entries },
    });

    expect(planSummary).toMatch(/^Plan 0\/1 → · working: Recover after contradictory reviewer guidance/);
    expect(planSummary).toContain('…');
    expect(emptyState).toMatch(/^Waiting for this turn to start\. Up next: Recover after contradictory reviewer guidance/);
    expect(emptyState).toContain('…');
  });

  it('keeps plan summaries stable for empty and all-null plan payloads', () => {
    expect(formatTuiPlanSummary([])).toBe('Plan --');
    expect(formatTuiPlanSummary([null, undefined, null])).toBe('Plan 0/3 ···');
  });

  it('summarizes pane activity defensively when transcript metadata is partial or missing', () => {
    expect(formatTuiPaneSummary({
      pane: { tools: null, reasoning: undefined, chars: undefined },
      plan: null,
    })).toBe('No plan or transcript yet.');

    expect(formatTuiPaneSummary({
      pane: {
        tools: [{ id: 'tool-1' }, { id: 'tool-2' }],
        reasoning: { blocks: [{ id: 'r1' }, { id: 'r2' }] },
        chars: 4096,
      },
      plan: { entries: [{ status: 'completed' }, { status: 'pending' }] },
    })).toBe('2 tools · 2 thoughts · 4096 chars · plan 1/2');
  });

  it('formats rich token usage without dropping available telemetry', () => {
    expect(formatTuiUsageLabel(null)).toBe('tokens --');
    expect(formatTuiUsageLabel({
      used: 12_345,
      size: 200_000,
      inputTokens: 100_000,
      outputTokens: 25_000,
      totalTokens: 125_000,
      cachedReadTokens: 10_000,
      cachedWriteTokens: 500,
      thoughtTokens: 7_500,
      cost: 0.0123,
    })).toBe('ctx 12.3K/200K · total 125K in 100K out 25K · cache r10K w500 · think 7.5K · $0.01');
  });
  it('prefers error and stop-reason status lines before falling back to pane summaries', () => {
    expect(formatTuiPaneStatusLine({
      pane: { error: 'disk full while persisting transcript' },
      plan: { entries: [{ content: 'irrelevant', status: 'completed' }] },
    })).toEqual({
      text: 'error: disk full while persisting transcript',
      color: 'red',
      dim: false,
    });

    expect(formatTuiPaneStatusLine({
      pane: { stopReason: 'end_turn' },
      plan: { entries: [{ content: 'still irrelevant', status: 'in_progress' }] },
    })).toEqual({
      text: 'completed: end turn',
      color: undefined,
      dim: true,
    });

    expect(formatTuiPaneStatusLine({
      pane: {
        tools: [{ id: 'tool-1' }],
        reasoning: { blocks: [] },
        chars: 12,
      },
      plan: null,
    })).toEqual({
      text: '1 tool · 12 chars',
      color: undefined,
      dim: true,
    });
  });

  it('sanitizes malformed stop reasons, save-path copy, and finish summaries before they reach the chrome', () => {
    expect(formatTuiPaneStatusLine({
      pane: { error: '\u001b[31mdisk\nfull\twhile saving\u001b[0m' },
      plan: null,
    })).toEqual({
      text: 'error: disk full while saving',
      color: 'red',
      dim: false,
    });

    expect(formatTuiPaneStatusLine({
      pane: { stopReason: 'end_turn_after_retry' },
      plan: null,
    })).toEqual({
      text: 'completed: end turn after retry',
      color: undefined,
      dim: true,
    });

    expect(formatTuiPreferenceStatus({
      save: true,
      path: 'C:\\Users\\admin\\.acp-author-reviewer-loop.json',
    })).toBe('Save defaults · On (C:\\Users\\admin\\.acp-author-reviewer-loop.json)');

    expect(formatTuiPreferenceStatus({
      save: false,
      path: 'ignored',
    })).toBe('Save defaults · Off');

    expect(formatTuiFinishSummary({ rounds: 2, maxRounds: 5 })).toBe('Approved · 2/5 rounds · ready for handoff');
  });

  it('surfaces actionable empty states for launching, pending, completed, and failed panes', () => {
    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: null,
      status: 'launching',
      phase: Phase.Launching,
      selectedRound: null,
      plan: null,
    })).toBe('Launching AUTHOR session...');

    expect(formatTuiEmptyState({
      role: 'REVIEWER',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Running,
      selectedRound: 2,
      plan: { entries: [{ content: 'Verify the huge-input path', status: 'pending' }] },
    })).toBe('Waiting for this turn to start. Up next: Verify the huge-input path');

    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Completed,
      phase: Phase.Done,
      selectedRound: 1,
      plan: null,
    })).toBe('Turn completed without visible output in this pane.');

    expect(formatTuiEmptyState({
      role: 'REVIEWER',
      pane: { error: 'disk full while saving transcript' },
      status: PaneStatus.Failed,
      phase: Phase.Error,
      selectedRound: 1,
      plan: null,
    })).toBe('Turn failed before output reached this pane.');
  });

  it('tells users when the loop has not started a first round yet', () => {
    expect(formatTuiEmptyState({
      role: 'AUTHOR',
      pane: {},
      status: PaneStatus.Pending,
      phase: Phase.Idle,
      selectedRound: null,
      plan: null,
    })).toBe('Standing by for round 1.');
  });

  it('formats animated terminal tab titles for major TUI states', () => {
    expect(formatTuiTerminalTitle({ awaitingSetup: true, frame: 0 })).toBe('ACP Review ·   · setup');
    expect(formatTuiTerminalTitle({ state: { phase: Phase.Launching }, frame: 1 })).toBe('ACP Review ◓ · launching');
    expect(formatTuiTerminalTitle({
      state: {
        phase: Phase.Running,
        latest: 2,
        order: [1, 2],
        rounds: new Map([[2, {
          AUTHOR: { status: PaneStatus.Completed },
          REVIEWER: { status: PaneStatus.Running },
        }]]),
      },
      frame: 0,
    })).toBe('ACP Review ◐ · R2 · REVIEWER running');
    expect(formatTuiTerminalTitle({ state: { phase: Phase.Done, result: { approved: true } } })).toBe('ACP Review · approved');
  });
});
