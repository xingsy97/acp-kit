<script setup lang="ts">
import { ref } from 'vue';

const command = 'npm install @acp-kit/core';
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1400);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="install-command" role="group" aria-label="Install command">
    <span class="install-prompt">$</span>
    <code class="install-text">{{ command }}</code>
    <button
      type="button"
      class="install-copy"
      :class="{ copied }"
      @click="copy"
      :aria-label="copied ? 'Copied' : 'Copy install command'"
    >
      <span v-if="!copied" class="copy-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="4.5" y="4.5" width="8" height="9" rx="1.5" />
          <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
        </svg>
      </span>
      <span v-else class="copy-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      </span>
      <span class="copy-label">{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
  </div>
</template>

<style scoped>
.install-command {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 4px;
  padding: 8px 10px 8px 14px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13.5px;
  max-width: 100%;
}

.install-prompt {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  user-select: none;
}

.install-text {
  color: var(--vp-c-text-1);
  background: transparent;
  padding: 0;
  font-size: 13.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.install-copy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  border-radius: 6px;
  padding: 4px 9px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.install-copy:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.install-copy.copied {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.copy-icon {
  display: inline-flex;
}
</style>
