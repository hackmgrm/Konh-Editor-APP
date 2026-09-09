export interface WritingCommand { name: string; prompt: string }
export const WRITING_COMMANDS: WritingCommand[] = [
  { name: '标题', prompt: '阅读当前文章，给出五个忠于正文、角度不同的标题候选。只在对话中返回，不修改文件。' },
  { name: '摘要', prompt: '阅读当前文章，写一段不超过120字的公众号摘要。只在对话中返回，不修改文件。' },
  { name: '润色', prompt: '阅读当前文章，保留事实和作者语气，提出润色建议。先在对话中展示建议，不修改文件。' },
  { name: '提纲', prompt: '根据当前文章和引用素材整理文章提纲，标明素材来源。只在对话中返回，不修改文件。' },
];
export function parseWritingCommands(raw: string | null): WritingCommand[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is WritingCommand => !!item && typeof item.name === 'string' && /^[^\s/]{1,20}$/.test(item.name) && typeof item.prompt === 'string' && item.prompt.trim().length > 0 && item.prompt.length <= 4000).slice(0, 30) : [];
  } catch { return []; }
}
export function composerQuery(input: string): { kind: '@' | '/'; query: string; start: number } | null {
  const match = /(?:^|\s)(@([^\s@]*)|\/([^\s/]*))$/.exec(input);
  if (!match) return null;
  const kind = match[2] !== undefined ? '@' : '/';
  const query = match[2] ?? match[3];
  return { kind, query, start: input.length - query.length - 1 };
}
