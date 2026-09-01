import { ClipboardText, X } from '@phosphor-icons/react';
import type { PreflightIssue } from '../preflight';
import { hasBlockingIssues } from '../preflight';
import PreflightIssues from './PreflightIssues';

interface Props {
  open: boolean;
  issues: readonly PreflightIssue[];
  onClose: () => void;
  onContinue: () => void;
}

export default function PreflightDialog({ open, issues, onClose, onContinue }: Props) {
  if (!open) return null;
  const blocked = hasBlockingIssues(issues);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal preflight-modal" role="dialog" aria-modal="true" aria-label="复制前检查" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head"><h2>复制前检查</h2><button className="modal-close" onClick={onClose} aria-label="关闭"><X size={15} weight="bold" /></button></header>
        <div className="modal-body"><p className="form-note">检查的是公众号粘贴后容易出问题的内容，不会修改原文。</p><PreflightIssues issues={issues} /></div>
        <footer className="modal-foot"><button className="btn" onClick={onClose}>{blocked ? '返回修改' : '取消'}</button><button className="btn primary" onClick={onContinue} disabled={blocked}><ClipboardText size={15} weight="bold" />仍然复制</button></footer>
      </div>
    </div>
  );
}
