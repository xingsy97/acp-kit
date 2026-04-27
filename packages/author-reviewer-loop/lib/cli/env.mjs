import process from 'node:process';

export function env(name, fallback, { empty = fallback } = {}) {
  if (!(name in process.env)) return fallback;
  const value = process.env[name]?.trim();
  return value || empty;
}

export function envChoice(name, choices, fallback) {
  const id = env(name, fallback).toLowerCase();
  const choice = choices[id];
  if (!choice) {
    throw new Error(
      `${name}=${id} is not supported. Use one of: ${Object.keys(choices).join(', ')}.`,
    );
  }
  return choice;
}

export function envFlag(name) {
  return process.env[name] === '1';
}

export function envPositiveInt(name, fallback) {
  const parsed = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
