import { isAbsolute, relative, resolve } from 'node:path';
import {
  PermissionDecision,
  createAcpRuntime,
  createRuntimeInspector,
} from '@acp-kit/core';
import { createLocalFileSystemHost, createLocalTerminalHost } from '@acp-kit/core/node';
import { formatEnvAssignment } from '../config/shell.mjs';

export async function openRole({ role, settings, cwd, trace, captureTrace, renderer }) {
  const inspector = createRuntimeInspector({ includeWire: Boolean(trace || captureTrace) });
  const unsubscribeTrace = renderer.onTraceEntry
    ? inspector.onEntry((entry) => renderer.onTraceEntry({ role, entry }))
    : () => {};
  const fsHost = createLocalFileSystemHost({ root: cwd });
  const terminalHost = createLocalTerminalHost({
    resolveCwd: (requestedCwd) => resolveTerminalCwd(cwd, requestedCwd),
  });
  renderer.onRoleStatus?.({ role, message: 'launching...' });

  const runtime = createAcpRuntime({
    agent: settings.agent,
    inspector,
    host: {
      ...fsHost,
      ...terminalHost,
      // This demo is intentionally unattended after the initial CLI confirmation.
      requestPermission: async () => PermissionDecision.AllowAlways,
      chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    },
  });

  try {
    const session = await runtime.newSession({ cwd });
    if (settings.model) {
      renderer.onRoleStatus?.({ role, message: `session ready, setting model ${settings.model}...` });
      await setRequiredModel({ role, session, settings });
    } else {
      renderer.onRoleStatus?.({ role, message: 'session ready, leaving default model unchanged...' });
    }
    renderer.onRoleStatus?.({ role, message: 'ready' });
    return {
      role,
      inspector,
      session,
      close: async () => {
        unsubscribeTrace();
        for (const child of terminalHost.terminals.values()) {
          if (!child.killed) child.kill('SIGKILL');
        }
        await session.dispose();
        await runtime.shutdown();
      },
    };
  } catch (error) {
    unsubscribeTrace();
    await runtime.shutdown().catch(() => undefined);
    if (trace) {
      console.error(inspector.toJSONL());
    }
    throw error;
  }
}

function resolveTerminalCwd(root, requestedCwd) {
  const resolvedRoot = resolve(root);
  const resolvedCwd = !requestedCwd
    ? resolvedRoot
    : isAbsolute(requestedCwd)
      ? resolve(requestedCwd)
      : resolve(resolvedRoot, requestedCwd);

  const rel = relative(resolvedRoot, resolvedCwd);
  if (rel && (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    throw new Error(`Terminal cwd escapes workspace root: ${requestedCwd}`);
  }
  return resolvedCwd;
}

async function setRequiredModel({ role, session, settings }) {
  const models = getAvailableModels(session);
  if (models.length > 0 && !models.some((model) => model.id === settings.model)) {
    throw createConfigurationError(formatUnavailableModelError({ role, settings, models }));
  }

  try {
    await session.setModel(settings.model);
  } catch (error) {
    throw createConfigurationError(formatRejectedModelError({ role, settings, models, error }));
  }
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}

function getAvailableModels(session) {
  const available = session.transcript?.session?.models?.availableModels;
  if (!Array.isArray(available)) return [];
  return available
    .map((model) => ({
      id: model.modelId || model.id,
      name: model.name,
    }))
    .filter((model) => typeof model.id === 'string' && model.id.length > 0);
}

function formatUnavailableModelError({ role, settings, models }) {
  const example = formatEnvAssignment(settings.modelEnvName, models[0]?.id ?? '<model-id>');
  const useDefault = formatEnvAssignment(settings.modelEnvName, '');
  return [
    `${settings.modelEnvName}="${settings.model}" is not available for ${settings.agent.displayName}.`,
    '',
    formatModelList(models),
    '',
    `Choose one of those models, for example:`,
    `  ${example}`,
    '',
    `Or use the agent default:`,
    `  ${useDefault}`,
    '',
    `${role} did not start because the configured model was rejected before the first turn.`,
  ].join('\n');
}

function formatRejectedModelError({ role, settings, models, error }) {
  const useDefault = formatEnvAssignment(settings.modelEnvName, '');
  const lines = [
    `${settings.modelEnvName}="${settings.model}" was rejected by ${settings.agent.displayName}.`,
    '',
  ];
  if (models.length > 0) {
    lines.push(formatModelList(models), '');
  } else {
    lines.push(
      'This agent did not report an available model list, so ACP Kit cannot suggest valid model ids.',
      '',
    );
  }
  lines.push(
    `Set ${settings.modelEnvName} to a supported model id, or use the agent default:`,
    `  ${useDefault}`,
    '',
    `${role} did not start because the configured model could not be applied.`,
    '',
    `Caused by: ${error instanceof Error ? error.message : String(error)}`,
  );
  return lines.join('\n');
}

function formatModelList(models) {
  return [
    'Available models:',
    ...models.map((model) => `  - ${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ''}`),
  ].join('\n');
}

export async function closeRole(state) {
  if (!state) return;
  await state.close().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}
