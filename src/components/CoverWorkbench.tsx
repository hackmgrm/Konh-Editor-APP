import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';

interface Props {
  open: boolean;
  source: { dataUrl: string; filename: string } | null;
  onClose: () => void;
  onApply: (cover: { dataUrl: string; filename: string }) => void;
}

export default function CoverWorkbench({ open, source, onClose, onApply }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState<'wide' | 'square'>('wide');
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  useEffect(() => {
    if (!open || !source || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const width = 900;
    const height = ratio === 'wide' ? 383 : 900;
    canvas.width = width; canvas.height = height;
    const image = new Image();
    image.onload = () => {
      const scale = Math.max(width / image.width, height / image.height);
      const sw = width / scale, sh = height / scale;
      const sx = (image.width - sw) * (x / 100), sy = (image.height - sh) * (y / 100);
      canvas.getContext('2d')?.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
    };
    image.src = source.dataUrl;
  }, [open, source, ratio, x, y]);
  if (!open || !source) return null;
  return <div className="dialog-backdrop cover-layer"><section className="dialog cover-workbench" role="dialog" aria-modal="true">
    <header className="dialog-head"><div><h2>封面工作台</h2><p>裁切公众号头图与分享方图</p></div><button className="ghost-btn" onClick={onClose}><X size={17} /></button></header>
    <div className="cover-canvas-wrap"><canvas ref={canvasRef} /></div>
    <div className="cover-controls">
      <label>规格<select value={ratio} onChange={(event) => setRatio(event.target.value as 'wide' | 'square')}><option value="wide">公众号头图 2.35:1</option><option value="square">分享方图 1:1</option></select></label>
      <label>水平焦点<input type="range" min="0" max="100" value={x} onChange={(event) => setX(Number(event.target.value))} /></label>
      <label>垂直焦点<input type="range" min="0" max="100" value={y} onChange={(event) => setY(Number(event.target.value))} /></label>
    </div>
    <footer className="modal-foot"><button className="btn" onClick={onClose}>取消</button><button className="btn primary" onClick={() => onApply({ dataUrl: canvasRef.current!.toDataURL('image/jpeg', .92), filename: `cover-${ratio}.jpg` })}>应用为封面</button></footer>
  </section></div>;
}
