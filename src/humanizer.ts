export type HumanizeStrength = 'light' | 'standard' | 'deep';

const STRENGTH: Record<HumanizeStrength, string> = {
  light: '轻度：只删除明显套话、冗余连接词和机械强调，尽量不改句序。',
  standard: '标准：清理套话并调整句长、段落节奏和重复结构，可重写句子。',
  deep: '深度：允许重组段落、强化作者观点和具体细节，但不得改变事实与结论。',
};

export function buildHumanizePrompt(text: string, strength: HumanizeStrength): string {
  if (!text.trim()) throw new Error('没有可处理的正文');
  return `你是一位克制的中文文字编辑。请去除下面文章中的 AI 生成痕迹，让它像真实作者写的。

处理强度：${STRENGTH[strength]}

规则：
1. 删除“此外、至关重要、深入探讨、赋能、彰显”等空泛套话，减少宣传腔和模糊归因。
2. 打破机械三段式、否定式排比、同义词循环、整齐得不自然的句式；混合长短句。
3. 减少破折号、粗体、表情符号、内联标题清单和刻意金句，但保留真正必要的格式。
4. 信任读者，直接陈述；允许第一人称、明确判断和具体场景，不凭空注入经历。
5. 严格保留事实、数字、专有名词、URL、图片引用、代码块、Markdown 标题层级和 Front Matter。
6. 不新增事实、来源、案例或引语。只返回修改后的完整正文，不解释，不加代码围栏。

原文：
${text}`;
}
