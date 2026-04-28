import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const CONFIG_FILE_NAME = '.acp-author-reviewer-loop.json';

export function preferencesFilePath() {
  return path.join(os.homedir(), CONFIG_FILE_NAME);
}

export function readPreferences({ filePath = preferencesFilePath() } = {}) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw createConfigurationError(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writePreferences(selection, { filePath = preferencesFilePath() } = {}) {
  const next = normalizePreferences(selection);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (!isReplaceRenameError(error)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw createConfigurationError(`Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    author: normalizeRole(source.author ?? {
      agent: source.authorAgent,
      model: source.authorModel,
    }),
    reviewer: normalizeRole(source.reviewer ?? {
      agent: source.reviewerAgent,
      model: source.reviewerModel,
    }),
  };
}

function normalizeRole(value) {
  const role = value && typeof value === 'object' ? value : {};
  return {
    agent: typeof role.agent === 'string' && role.agent.trim() ? role.agent.trim().toLowerCase() : undefined,
    model: typeof role.model === 'string' ? role.model.trim() || null : role.model === null ? null : undefined,
  };
}

function isReplaceRenameError(error) {
  return error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES';
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}
