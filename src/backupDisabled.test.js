import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';

/**
 * The unified backup panel used to be a design preview with a disabled button,
 * and the native module that backs it was deliberately left out of the build.
 * These checks fail if either side drifts back into that half-finished state:
 * the settings view must render the real panel, the panel must call the real
 * commands, and lib.rs must register both the module and its state.
 *
 * They also keep the old, narrower prototypes from quietly returning to the
 * settings dialog where they would look like the complete feature.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const COMMANDS = [
  'begin',
  'put_journal_images',
  'abort',
  'finish',
  'inspect',
  'read_file',
  'restore_workspace',
  'restore_planner',
  'restore_writing',
];

test('the settings view renders the working backup panel, not a preview', () => {
  const settings = read('./tongyun/components/SettingsView.tsx');
  assert.match(settings, /UnifiedBackupPanel/);
  assert.doesNotMatch(settings, /UnifiedBackupPreview/);
});

test('the panel drives every native command', () => {
  const panel = read('./tongyun/components/sync/UnifiedBackupPanel.tsx');
  const api = read('./unifiedBackup.ts');
  for (const call of [
    'runUnifiedExport',
    'inspectUnifiedBackup',
    'restorePlannerFromBackup',
    'restoreWorkspaceFromBackup',
    'restoreWritingAssetsFromBackup',
  ]) {
    assert.match(panel, new RegExp(call), `${call} is never used`);
  }
  for (const command of COMMANDS) {
    assert.match(api, new RegExp(`unified_backup_${command}`), `${command} is not invoked`);
  }
  assert.doesNotMatch(panel, /当前不支持统一备份/);
});

test('the native module and its state are registered', () => {
  const native = read('../src-tauri/src/lib.rs');
  assert.match(native, /^mod unified_backup;$/m);
  assert.match(native, /\.manage\(unified_backup::UnifiedBackup::default\(\)\)/);
  for (const command of COMMANDS) {
    assert.match(native, new RegExp(`unified_backup::unified_backup_${command}\\b`), `${command} is not registered`);
  }
});

test('the old workspace-only dialog is not reachable from settings', () => {
  const dialog = read('./components/SettingsDialog.tsx');
  assert.doesNotMatch(dialog, /WorkspaceBackup/);
});
