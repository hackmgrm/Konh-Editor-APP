export type DeepTalkCategory = 'tech' | 'ai' | 'freight';
export type DeepTalkStyle = 'professional' | 'casual' | 'academic';
export type DeepTalkLength = 'short' | 'medium' | 'long';
export type DeepTalkTemplate = 'auto' | 'tutorial' | 'analysis' | 'news' | 'story' | 'listicle' | 'review';
export type DeepTalkDestination = 'new' | 'current';

export interface DeepTalkOptions {
  topic: string;
  category: DeepTalkCategory;
  style: DeepTalkStyle;
  length: DeepTalkLength;
  template: DeepTalkTemplate;
  destination: DeepTalkDestination;
  activeId?: string;
}

const CATEGORY_GUIDES: Record<DeepTalkCategory, string> = {
  tech: '技术：保证技术细节准确，给出可操作的示例，并解释适用边界',
  ai: 'AI：兼顾前沿进展、原理、应用场景与局限，不虚构研究或数据',
  freight: '货代：围绕国际货运代理、航线与运力、运价、时效、单证、清关和供应链实务展开；术语准确，区分事实与行业判断，不虚构运价或政策',
};

const STYLE_GUIDES: Record<DeepTalkStyle, string> = {
  professional: '专业严谨，逻辑清楚，适合业内读者',
  casual: '自然轻松，少用术语和说教口吻，适合大众阅读',
  academic: '论证克制，概念定义清楚，适合研究参考',
};

const LENGTH_GUIDES: Record<DeepTalkLength, string> = {
  short: '500–800 字，简洁精炼',
  medium: '1500–2500 字，详实完整',
  long: '3000–5000 字，深度分析',
};

const TEMPLATE_GUIDES: Record<Exclude<DeepTalkTemplate, 'auto'>, string> = {
  tutorial: '简介与收获 → 前置条件 → 分步讲解 → 常见问题 → 总结与延伸',
  analysis: '背景 → 核心观点 → 多角度论证 → 案例或数据 → 反方观点 → 结论与展望',
  news: '导语（5W1H）→ 事件详情 → 各方反应 → 影响分析 → 延伸信息',
  story: '引子 → 背景铺垫 → 情节发展 → 转折 → 结局 → 具体感悟',
  listicle: '说明清单价值 → 逐项展开 → 快速总结',
  review: '对象简介 → 评测维度 → 详细体验 → 优缺点 → 适用人群 → 建议',
};

export function detectDeepTalkTemplate(topic: string): Exclude<DeepTalkTemplate, 'auto'> {
  const rules: Array<[Exclude<DeepTalkTemplate, 'auto'>, string[]]> = [
    ['tutorial', ['教程', '如何', '怎么', '步骤', '入门', '安装', '配置', 'guide', 'how to']],
    ['news', ['新闻', '发布', '宣布', '推出', '更新', '最新', '快讯']],
    ['listicle', ['清单', '盘点', '排行榜', '个技巧', '个方法', 'top', 'best']],
    ['review', ['评测', '测评', '体验', '对比', '优缺点', 'review', ' vs ']],
    ['story', ['故事', '经历', '那天', '感受', '遇见', '我的', 'story']],
  ];
  const normalized = ` ${topic.toLowerCase()} `;
  return rules.find(([, words]) => words.some((word) => normalized.includes(word)))?.[0] ?? 'analysis';
}

/**
 * Build the task given to the existing workspace agent. The workflow is based
 * on DeepTalk's category/template generator, adapted to the editor's guarded
 * read/write tools instead of introducing a second OpenAI client and file store.
 */
export function buildDeepTalkPrompt(options: DeepTalkOptions): string {
  const topic = options.topic.trim();
  if (!topic) throw new Error('请填写文章主题');
  const template = options.template === 'auto'
    ? detectDeepTalkTemplate(topic)
    : options.template;
  const target = options.destination === 'current' && options.activeId
    ? `先读取当前文章「${options.activeId}」，将它作为素材并完整改写；最后把成稿写回这个文件。`
    : '创建一篇新的 Markdown 文件；用最终标题生成简短、安全、不重复的中文文件名，不要覆盖已有文件。';

  return `使用“深言”工作流完成一篇公众号文章，并实际写入工作区。

主题：${topic}
领域：${CATEGORY_GUIDES[options.category]}
语气：${STYLE_GUIDES[options.style]}
篇幅：${LENGTH_GUIDES[options.length]}
结构：${TEMPLATE_GUIDES[template]}
写入：${target}

要求：
1. 先形成清晰观点再写作，不堆砌空话；事实、数据、引语和来源不得编造，不确定的信息明确标注。
2. 输出为可直接编辑的 Markdown：首行是唯一的一级标题；正文用二级标题组织；文末给出 3–5 个标签。
3. 开头直接建立问题或冲突，中段用案例和推理推进，结尾落到具体判断或行动，不写模板化“综上所述”。
4. 完成文件写入后，回复文件路径和一句话内容摘要。`;
}
