// One reading of an on/off setting for every runtime reader. src/config.ts
// reads a boolean flag (e.g. HEARTBEAT_AGENT_ENABLED, WEB_PUBLIC_ENABLED)
// as on for any of these values; the Settings page itself writes "1".
// Accepting multiple truthy spellings avoids half-switched installs when a
// setting is written manually (e.g. FLAG=true vs FLAG=1).

import { getEffectiveSettingValue } from './settings-store.js'

export const SETTING_ON_VALUES: readonly string[] = ['1', 'true', 'yes', 'on']

export function isSettingValueOn(raw: unknown): boolean {
  return SETTING_ON_VALUES.includes(String(raw ?? '').trim().toLowerCase())
}

/** The effective value (override > .env > default) read as on/off; an unknown key is off. */
export function isSettingOn(key: string): boolean {
  try { return isSettingValueOn(getEffectiveSettingValue(key)) } catch { return false }
}
