import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

type Mode = 'export' | 'import';

/** Manual workspace-only backup. Planner data requires a separate future API. */
export default function WorkspaceBackup() {
  const [mode, setMode] = useState<Mode>('export');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  async function chooseSource() {
    try {
      const selected = await open({ directory: true, multiple: false, title: mode === 'export' ? '选择工作区' : '选择备份目录' });
      if (typeof selected === 'string') setSource(selected);
    } catch (error) { setMessage(`选择目录失败：${String(error)}`); }
  }

  async function run() {
    if (lock.current || !native || !source.trim() || !destination.trim()) return;
    lock.current = true;
    setBusy(true);
    setMessage('');
    try {
      await invoke(mode === 'export' ? 'workspace_backup_export' : 'workspace_backup_import',
        mode === 'export' ? { workspace: source, destination } : { backup: source, destination });
      setMessage(mode === 'export' ? `备份已创建：${destination}` : `已恢复到新目录：${destination}。请手动打开该工作区。`);
    } catch (error) {
      setMessage(`操作失败：${String(error)}。如果目标目录已被创建，请检查并手动删除残留后再重试。`);
    } finally { lock.current = false; setBusy(false); }
  }

  return <section className="form-section" aria-label="工作区备份与恢复">
    <div className="form-section-label">工作区备份与恢复</div>
    <p className="form-note">仅手动复制所选工作区目录，不是统一备份或自动同步。不包含应用数据库、设置、凭据和计划数据（除非文件本身位于工作区内）。</p>
    <p className="form-warn">备份未加密；校验只能检测意外损坏，不能验证来源。仅使用可信的本地目录；操作期间请停止编辑和同步，不要修改备份。</p>
    <p className="form-note">目标必须是尚不存在的新目录，其父目录须已存在且不能位于来源内。恢复不会覆盖或自动打开现有工作区。符号链接和特殊文件不受支持，权限、时间戳等元数据不会保留。</p>
    {!native && <p className="form-note">此功能仅在桌面版可用。</p>}
    <fieldset disabled={busy || !native}>
      <label className="field"><span>操作</span><select value={mode} onChange={(e) => { setMode(e.target.value as Mode); setSource(''); setDestination(''); setMessage(''); }}><option value="export">备份工作区</option><option value="import">恢复工作区</option></select></label>
      <label className="field"><span>{mode === 'export' ? '工作区目录' : '备份目录（含 manifest.json）'}</span><span className="field-with-action"><input value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} /><button type="button" className="btn" onClick={() => void chooseSource()}>选择目录</button></span></label>
      <label className="field"><span>新目标目录完整路径</span><input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="输入尚不存在的目录路径" spellCheck={false} /></label>
      <button type="button" className="btn" disabled={!source.trim() || !destination.trim()} onClick={() => void run()}>{busy ? '处理中…' : mode === 'export' ? '创建备份' : '恢复到新目录'}</button>
    </fieldset>
    {message && <p role="status" className="form-note">{message}</p>}
  </section>;
}
