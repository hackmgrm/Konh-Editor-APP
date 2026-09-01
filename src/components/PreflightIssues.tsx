import { CheckCircle, Warning, XCircle } from '@phosphor-icons/react';
import type { PreflightIssue } from '../preflight';

export default function PreflightIssues({ issues }: { issues: readonly PreflightIssue[] }) {
  if (!issues.length) {
    return <div className="preflight-clear"><CheckCircle size={15} weight="fill" />检查通过，可以继续。</div>;
  }
  return (
    <div className="preflight-list">
      {issues.map((item) => (
        <div key={item.id} className={`preflight-item ${item.severity}`}>
          {item.severity === 'error' ? <XCircle size={16} weight="fill" /> : <Warning size={16} weight="fill" />}
          <div><strong>{item.title}</strong><span>{item.detail}</span></div>
        </div>
      ))}
    </div>
  );
}
