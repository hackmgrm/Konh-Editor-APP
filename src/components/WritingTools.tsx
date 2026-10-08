import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  article: string;
  mode: 'titles' | 'cover';
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onTitle?: (title: string) => void;
  onCover?: (cover: { dataUrl: string; filename: string }) => void;
}

export default function WritingTools({ article, mode, disabled, onBusyChange, onTitle, onCover }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [requirement, setRequirement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [titles, setTitles] = useState<string[]>([]);
  const sequence = useRef(0);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    sequence.current++;
    setBusy(false); setTitles([]); setError('');
    return () => { sequence.current++; };
  }, [article]);
  const generate = async () => {
    const id = ++sequence.current;
    setBusy(true); setError('');
    try {
      if (mode === 'titles') {
        const result = await invoke<string[]>('writing_suggest', { article, requirement });
        if (sequence.current === id) setTitles(result);
      } else {
        const dataUrl = await invoke<string>('writing_cover', { article, requirement });
        if (sequence.current === id) onCover?.({ dataUrl, filename: 'ai-cover.png' });
      }
    } catch (err) {
      if (sequence.current === id) setError(String(err));
    } finally {
      if (sequence.current === id) setBusy(false);
    }
  };
  return <div className="writing-tools">
    <button type="button" className="btn" disabled={disabled || busy} onClick={() => setExpanded(!expanded)}>{mode === 'titles' ? 'AI 标题候选' : 'AI 生成封面'}</button>
    {expanded && <div className="writing-tools-body">
      <label className="field"><span>{mode === 'titles' ? '标题要求' : '封面风格'}</span><input value={requirement} disabled={busy} onChange={e => setRequirement(e.target.value)} placeholder={mode === 'titles' ? '例如：突出实测结果、更口语化' : '例如：极简、科技感、紫色与青柠绿'} maxLength={500} /></label>
      {mode === 'cover' && <p className="form-hint">使用设置中的图片生成 API。生成后进入封面工作台裁切，应用后才替换封面。</p>}
      <button type="button" className="btn" disabled={busy || disabled || !article.trim()} onClick={() => void generate()}>{busy ? '生成中…' : titles.length ? '重新生成' : '生成'}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="title-candidates">{titles.map(title => <button type="button" className="btn" key={title} disabled={busy || disabled} onClick={() => onTitle?.(title)}><span>{title}</span><small>选用</small></button>)}</div>
    </div>}
  </div>;
}
