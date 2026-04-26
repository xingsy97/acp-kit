<script setup lang="ts">
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';

type AgentId = 'copilot' | 'claude' | 'codex';
type Mode = 'quick' | 'advanced';

type AgentPreset = {
  id: AgentId;
  label: string;
  iconId: string;
  prompt: string;
};

const agents: AgentPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    iconId: 'claude',
    prompt: 'Write a demo for this repo'
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    iconId: 'codex',
    prompt: 'Write a demo for this repo'
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    iconId: 'copilot',
    prompt: 'Write a demo for this repo'
  }
];

const modes: { id: Mode; label: string; hint: string }[] = [
  { id: 'quick',    label: 'Quick',    hint: 'One call. Auto-managed runtime + session.' },
  { id: 'advanced', label: 'Advanced', hint: 'Explicit runtime + session for multi-turn or multi-session apps.' }
];

const selectedAgent = ref<AgentId>('claude');
const selectedMode = ref<Mode>('quick');

const selected = computed(
  () => agents.find((a) => a.id === selectedAgent.value) ?? agents[0]
);
const mode = computed(
  () => modes.find((m) => m.id === selectedMode.value) ?? modes[0]
);

const iconSprite = withBase('/agent-icons.svg');

const kw = (s: string) => `<span class="tk-kw">${s}</span>`;
const str = (s: string) => `<span class="tk-str">"${s}"</span>`;
const fn = (s: string) => `<span class="tk-fn">${s}</span>`;
const v = (s: string) => `<span class="tk-var">${s}</span>`;
const p = (s: string) => `<span class="tk-prop">${s}</span>`;

const eventLoop = (indent: string) =>
  `${indent}${fn('onRuntimeEvent')}(${v('event')}, {
${indent}  ${p('messageDelta')}: (${v('e')}) =&gt; ${v('process')}.${p('stdout')}.${fn('write')}(${v('e')}.${p('delta')}),
${indent}  ${p('toolStart')}:    (${v('e')}) =&gt; ${v('console')}.${fn('log')}(${str('→ tool')}, ${v('e')}.${p('title')}),
${indent}  ${p('toolEnd')}:      (${v('e')}) =&gt; ${v('console')}.${fn('log')}(${str('  status')}, ${v('e')}.${p('status')}),
${indent}});`;

const quickCode = computed(() =>
  `${kw('import')} { ${fn('runOneShotPrompt')}, ${fn('onRuntimeEvent')} } ${kw('from')} ${str('@acp-kit/core')};

${kw('for await')} (${kw('const')} ${v('event')} ${kw('of')} ${fn('runOneShotPrompt')}({
  ${p('profile')}: ${str(selected.value.id)},
  ${p('cwd')}:     ${v('process')}.${fn('cwd')}(),
  ${p('prompt')}:  ${str(selected.value.prompt)}
})) {
${eventLoop('  ')}
}`
);

const advancedCode = computed(() =>
  `${kw('import')} { ${fn('createAcpRuntime')}, ${fn('PermissionDecision')} } ${kw('from')} ${str('@acp-kit/core')};

<span class="tk-comment">// One agent process, many sessions — reuse spawn cost.</span>
${kw('await using')} ${v('acp')} = ${fn('createAcpRuntime')}({
  ${p('profile')}: ${str(selected.value.id)},
  ${p('host')}:    { ${p('requestPermission')}: ${kw('async')} () =&gt; ${fn('PermissionDecision')}.${p('AllowOnce')} }
});

${kw('await using')} ${v('s1')} = ${kw('await')} ${v('acp')}.${fn('newSession')}({ ${p('cwd')}: ${v('process')}.${fn('cwd')}() });
${kw('await using')} ${v('s2')} = ${kw('await')} ${v('acp')}.${fn('newSession')}({ ${p('cwd')}: ${str('./packages/server')} });

${v('s1')}.${fn('on')}({
  ${p('messageDelta')}: (${v('e')}) =&gt; ${v('process')}.${p('stdout')}.${fn('write')}(${v('e')}.${p('delta')}),
  ${p('toolStart')}:    (${v('e')}) =&gt; ${v('console')}.${fn('log')}(${str('→ tool')}, ${v('e')}.${p('title')}),
});

${kw('await')} ${v('s1')}.${fn('prompt')}(${str(selected.value.prompt)});
${kw('await')} ${v('s2')}.${fn('prompt')}(${str('Cross-check the changes against existing tests.')});`
);

const code = computed(() =>
  selectedMode.value === 'quick' ? quickCode.value : advancedCode.value
);
</script>

<template>
  <section class="agent-demo" aria-label="Agent usage demo">
    <div class="agent-switch" role="tablist" aria-label="Select agent">
      <button
        v-for="agent in agents"
        :key="agent.id"
        class="agent-pill"
        role="tab"
        :aria-selected="selectedAgent === agent.id"
        :class="{ active: selectedAgent === agent.id }"
        @click="selectedAgent = agent.id"
      >
        <svg class="agent-icon" viewBox="0 0 24 24" aria-hidden="true">
          <use :href="`${iconSprite}#${agent.iconId}`" />
        </svg>
        <span>{{ agent.label }}</span>
      </button>
    </div>

    <div class="terminal-shell">
      <div class="terminal-titlebar">
        <span class="dot red" />
        <span class="dot amber" />
        <span class="dot green" />
        <div class="terminal-title">{{ selected.label }}</div>
      </div>

      <div class="mode-tabs" role="tablist" aria-label="Demo mode">
        <button
          v-for="m in modes"
          :key="m.id"
          class="mode-tab"
          role="tab"
          :aria-selected="selectedMode === m.id"
          :class="{ active: selectedMode === m.id }"
          @click="selectedMode = m.id"
        >{{ m.label }}</button>
        <span class="mode-hint">{{ mode.hint }}</span>
      </div>

      <div class="terminal-body">
        <div class="file-block">
          <pre class="code-block"><code v-html="code"></code></pre>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.agent-demo {
  margin: 18px 0 26px;
}

.agent-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.agent-pill {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.agent-pill:hover {
  border-color: var(--vp-c-brand-1);
}

.agent-pill.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.agent-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

.terminal-shell {
  --term-titlebar-bg: linear-gradient(180deg, #f6f7f9 0%, #eceff3 100%);
  --term-titlebar-border: #d9dde3;
  --term-title-color: #4b5565;
  --term-body-bg: #fbfcfd;
  --term-body-color: #1f2937;
  --tk-kw: #cf222e;
  --tk-str: #0a3069;
  --tk-fn: #6639ba;
  --tk-var: #953800;
  --tk-prop: #0550ae;

  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 28%, var(--vp-c-divider));
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 14px 32px rgba(2, 8, 20, 0.14);
}

.terminal-titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--term-titlebar-bg);
  border-bottom: 1px solid var(--term-titlebar-border);
  padding: 10px 12px;
}

.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  display: inline-block;
}

.dot.red {
  background: #ff5f56;
}

.dot.amber {
  background: #ffbd2e;
}

.dot.green {
  background: #27c93f;
}

.terminal-title {
  margin-left: 8px;
  font-size: 12px;
  color: var(--term-title-color);
  letter-spacing: 0.02em;
}

.mode-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 0;
  background: var(--term-body-bg);
  border-bottom: 1px solid var(--term-titlebar-border);
}

.mode-tab {
  border: none;
  background: transparent;
  color: var(--term-title-color);
  padding: 6px 12px;
  font: 500 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all 0.15s ease;
}

.mode-tab:hover {
  color: var(--term-body-color);
}

.mode-tab.active {
  color: var(--vp-c-brand-1);
  border-bottom-color: var(--vp-c-brand-1);
}

.mode-hint {
  margin-left: auto;
  padding: 0 4px 6px;
  font-size: 11px;
  color: var(--term-title-color);
  opacity: 0.8;
}

@media (max-width: 640px) {
  .mode-hint {
    display: none;
  }
}

.terminal-body {
  background: var(--term-body-bg);
  color: var(--term-body-color);
  padding: 0;
}

.file-block {
  padding: 14px 0;
}

.file-block pre {
  padding: 0 16px;
}

pre {
  margin: 0;
  white-space: pre-wrap;
}

code {
  font-size: 12px;
  line-height: 1.62;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.code-block .line {
  display: inline;
}
</style>

<style>
.terminal-shell .tk-kw   { color: var(--tk-kw); }
.terminal-shell .tk-str  { color: var(--tk-str); }
.terminal-shell .tk-fn   { color: var(--tk-fn); }
.terminal-shell .tk-var  { color: var(--tk-var); }
.terminal-shell .tk-prop { color: var(--tk-prop); }
.terminal-shell .tk-comment { color: var(--term-title-color); opacity: 0.7; font-style: italic; }
html.dark .terminal-shell {
  --term-titlebar-bg: linear-gradient(180deg, #2a2f3a 0%, #1f242e 100%);
  --term-titlebar-border: #1c2330;
  --term-title-color: #b6c4d4;
  --term-body-bg: #0d1118;
  --term-body-color: #d3e0ea;
  --tk-kw: #ff7b72;
  --tk-str: #a5d6ff;
  --tk-fn: #d2a8ff;
  --tk-var: #ffa657;
  --tk-prop: #79c0ff;
}

@media (max-width: 640px) {
  .terminal-body {
    padding: 12px;
  }

  .agent-pill {
    font-size: 12px;
  }
}
</style>
