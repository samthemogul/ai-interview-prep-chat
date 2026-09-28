import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CHAT_VIEW_ID, COMMANDS, EXTENSION_DISPLAY_NAME, ID } from '../src/constants';
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../src/settings/settings';

interface Manifest {
  displayName: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; category: string }>;
    views: Record<string, Array<{ id: string }>>;
    configuration: { properties: Record<string, { default: unknown }> };
    menus: Record<string, Array<{ command?: string }>>;
  };
}

const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as Manifest;

describe('package.json manifest', () => {
  it('uses the configured name', () => {
    expect(manifest.displayName).toBe(EXTENSION_DISPLAY_NAME);
    expect(manifest.contributes.commands.every((c) => c.category === EXTENSION_DISPLAY_NAME)).toBe(true);
  });

  it('declares exactly the commands the code registers', () => {
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    expect(declared).toEqual(Object.values(COMMANDS).sort());
  });

  it('only references declared commands in menus', () => {
    const declared = new Set(Object.values(COMMANDS));
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items) if (item.command) expect(declared.has(item.command as never)).toBe(true);
    }
  });

  it('declares every setting with the same default as the code', () => {
    const props = manifest.contributes.configuration.properties;
    expect(Object.keys(props).sort()).toEqual(SETTING_KEYS.map((k) => `${ID}.${k}`).sort());
    for (const key of SETTING_KEYS) expect(props[`${ID}.${key}`]!.default).toEqual(DEFAULT_SETTINGS[key]);
  });

  it('contributes the chat view and activates lazily', () => {
    expect(manifest.contributes.views[ID]!.map((v) => v.id)).toContain(CHAT_VIEW_ID);
    expect(manifest.activationEvents).toEqual([]);
  });
});
