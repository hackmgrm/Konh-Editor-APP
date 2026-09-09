import { useState } from 'react';
import { getConfig, setConfig } from '../store/appConfig';
import { WRITING_COMMANDS, composerQuery, parseWritingCommands } from '../writingCommands';

interface Props {
  input: string;
  onInput: (value: string) => void;
  files: string[];
  references: string[];
  onReferences: (files: string[]) => void;
  images: string[];
  onImages: (images: string[]) => void;
  onFiles: (files: File[]) => void;
  disabled: boolean;
}
export default function AgentAttachments({ input, onInput, files, references, onReferences, images, onImages, onFiles, disabled }: Props) {
  const [custom, setCustom] = useState(() => parseWritingCommands(getConfig('writing.commands')));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const query = composerQuery(input);
  const commands = [...WRITING_COMMANDS, ...custom];
  const replaceQuery = (value: string) => onInput(input.slice(0, query?.start ?? input.length) + value);
  return <div className="agent-attachments">
    <div className="attachment-actions">
      <button className="btn" disabled={disabled} onClick={() => onInput(input + (input && !/\s$/.test(input) ? ' @' : '@'))}>@ 素材</button>
      <label className="btn">图片<input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} onChange={e => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></label>
      <button className="btn" disabled={disabled} onClick={() => onInput(input + (input && !/\s$/.test(input) ? ' /' : '/'))}>/ 指令</button>
      <button className="btn" disabled={disabled} onClick={() => setEditing(!editing)}>管理指令</button>
    </div>
    {query && !disabled && <div className="composer-options" role="region" aria-label={query.kind === '@' ? '选择素材' : '选择指令'}>
      {query.kind === '@' ? <>
        {files.filter(file => file.toLowerCase().includes(query.query.toLowerCase()) && !references.includes(file)).slice(0, 20).map(file => <button className="btn" key={file} disabled={references.length >= 8} onClick={() => { onReferences([...references, file]); replaceQuery(''); }}>{file}</button>)}
        <small>最多 8 个文件；按文件路径筛选。点击选中，发送时读取最新内容。</small>
      </> : commands.filter(command => command.name.includes(query.query)).map(command => <button className="btn" key={command.name} onClick={() => replaceQuery(command.prompt)}>{command.name}</button>)}
    </div>}
    <div className="attachment-chips">{references.map(file => <button className="btn" key={file} disabled={disabled} title="移除素材" onClick={() => onReferences(references.filter(item => item !== file))}>{file} ×</button>)}</div>
    <div className="attachment-images">{images.map((src, i) => <button key={i} disabled={disabled} title="移除图片" onClick={() => onImages(images.filter((_, index) => index !== i))}><img src={src} alt={`附图 ${i + 1}`} /><span>×</span></button>)}</div>
    {images.length > 0 && <small className="form-hint">发送时图片将交给当前模型；请选择支持视觉输入的模型。</small>}
    {editing && <div className="writing-tools-body">
      <label className="field"><span>指令名称</span><input value={name} onChange={e => setName(e.target.value)} maxLength={20} placeholder="如：我的文风" /></label>
      <label className="field"><span>提示词</span><textarea value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} /></label>
      <button className="btn" disabled={disabled || !/^[^\s/]{1,20}$/.test(name) || !prompt.trim() || WRITING_COMMANDS.some(c => c.name === name) || (custom.length >= 30 && !custom.some(command => command.name === name))} onClick={() => { const next = [...custom.filter(c => c.name !== name), { name, prompt: prompt.trim() }]; setCustom(next); setConfig('writing.commands', JSON.stringify(next)); setName(''); setPrompt(''); }}>保存指令</button>
      {custom.map(command => <div className="saved-command" key={command.name}><button className="btn" onClick={() => { setName(command.name); setPrompt(command.prompt); }}>{command.name}</button><button className="btn" onClick={() => { const next = custom.filter(c => c.name !== command.name); setCustom(next); setConfig('writing.commands', JSON.stringify(next)); }}>删除</button></div>)}
    </div>}
  </div>;
}
