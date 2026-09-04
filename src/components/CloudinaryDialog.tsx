import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, CloudArrowUp, Copy, X } from '@phosphor-icons/react';
import {
  articleLocalImages,
  cloudinaryReady,
  getCloudinaryConfig,
  replaceArticleImages,
  uploadCloudinaryImage,
} from '../cloudinary';

interface Props {
  open: boolean;
  onClose: () => void;
  article: string;
  images: Record<string, string>;
  onReplace: (markdown: string) => void;
  onOpenSettings: () => void;
}

export default function CloudinaryDialog({ open, onClose, article, images, onReplace, onOpenSettings }: Props) {
  const found = useMemo(() => articleLocalImages(article, images), [article, images]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(found.slice(0, 10)));
    setReplace(false);
    setProgress('');
    setError('');
    setResults({});
    setCopied('');
  }, [open, found]);

  if (!open) return null;
  const config = getCloudinaryConfig();

  const run = async () => {
    const paths = [...selected].slice(0, 10);
    if (!paths.length || busy) return;
    setBusy(true);
    setError('');
    const uploaded: Record<string, string> = {};
    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        setProgress(`正在上传 ${i + 1}/${paths.length} · ${path.split('/').pop()}`);
        try {
          const result = await uploadCloudinaryImage(path, images[path], config.folder);
          uploaded[path] = result.secureUrl;
          setResults((old) => ({ ...old, [path]: result.secureUrl }));
        } catch (err) {
          setError((old) => [old, `${path}：${err instanceof Error ? err.message : String(err)}`].filter(Boolean).join('\n'));
        }
      }
      if (replace && Object.keys(uploaded).length) onReplace(replaceArticleImages(article, uploaded));
      setProgress(`完成：${Object.keys(uploaded).length}/${paths.length} 张上传成功${replace ? '，成功项已替换' : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (path: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(path)) next.delete(path); else if (next.size < 10) next.add(path);
    return next;
  });

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal cloudinary-modal" role="dialog" aria-modal="true" aria-label="Cloudinary 图片托管" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head"><h2>Cloudinary 图片托管</h2><button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={15} /></button></header>
        <div className="modal-body">
          {!cloudinaryReady(config) ? (
            <section className="form-section"><p className="form-note">先配置 Cloud Name、API Key 和 API Secret。凭据只保存在本机。</p><button className="btn primary" onClick={onOpenSettings}>打开设置</button></section>
          ) : found.length === 0 ? (
            <section className="form-section"><p className="form-note">当前文章没有引用工作区里的本地图片。</p></section>
          ) : (
            <section className="form-section">
              <p className="form-note">找到 {found.length} 张本地图。单次最多上传 10 张；已上传过的相同文件会直接复用链接。</p>
              <div className="cloudinary-list scroll-thin">
                {found.map((path) => <div key={path} className="cloudinary-row">
                  <label title={path}><input type="checkbox" checked={selected.has(path)} onChange={() => toggle(path)} disabled={busy || (!selected.has(path) && selected.size >= 10)} /><span>{path}</span></label>
                  {results[path] && <><CheckCircle size={14} weight="fill" /><button className="cloudinary-copy" onClick={() => void navigator.clipboard.writeText(results[path]).then(() => setCopied(path))} title="复制永久链接" aria-label={`复制 ${path} 的永久链接`}><Copy size={14} />{copied === path ? '已复制' : '复制链接'}</button></>}
                </div>)}
              </div>
              <label className="checkbox-field"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} disabled={busy} /><span>上传成功后替换当前文章中的本地引用</span></label>
              <p className="form-note">默认只上传并保留本地引用。启用替换后也只修改成功上传的图片，修改会进入文章版本历史。</p>
            </section>
          )}
          {error && <pre className="form-error cloudinary-errors">{error}</pre>}
        </div>
        <footer className="modal-foot"><span className="form-progress">{progress}</span><button className="btn" onClick={onClose} disabled={busy}>关闭</button><button className="btn primary" onClick={() => void run()} disabled={busy || !cloudinaryReady(config) || selected.size === 0}><CloudArrowUp size={15} />{busy ? '上传中…' : '开始上传'}</button></footer>
      </div>
    </div>
  );
}
