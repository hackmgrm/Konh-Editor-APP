import { parseFrontMatter } from './frontMatter.ts';

export type CheckSeverity = 'error' | 'warning';

export interface PreflightIssue {
  id: string;
  severity: CheckSeverity;
  title: string;
  detail: string;
}

export interface ArticleCheckInput {
  markdown: string;
  availableImages: ReadonlySet<string>;
  /** Parsed by the renderer's own image-reference rules. */
  referencedImages: ReadonlySet<string>;
  frontMatterEnabled: boolean;
  linkFootnotes: boolean;
}

export interface PublishFieldInput {
  title: string;
  digest: string;
  author: string;
  hasCover: boolean;
  keepsExistingCover: boolean;
  articleHasImage: boolean;
}

const issue = (id: string, severity: CheckSeverity, title: string, detail: string): PreflightIssue => ({
  id,
  severity,
  title,
  detail,
});

function headingJumps(markdown: string): string[] {
  const jumps: string[] = [];
  let previous = 0;
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    if (previous && level > previous + 1) jumps.push(`H${previous} → H${level}（${match[2].trim()}）`);
    previous = level;
  }
  return jumps;
}

/** Static checks shared by rich-text copy and draft publishing. */
export function checkArticle(input: ArticleCheckInput): PreflightIssue[] {
  const { markdown } = input;
  const issues: PreflightIssue[] = [];
  const plainCount = markdown.replace(/\s/g, '').length;
  if (!plainCount) return [issue('empty', 'error', '文章还是空的', '先写入正文，再复制或推送。')];

  const missing = [...input.referencedImages].filter((name) => {
    const base = name.split(/[\\/]/).pop() ?? name;
    return !input.availableImages.has(name) && !input.availableImages.has(base);
  });
  if (missing.length) {
    issues.push(issue('missing-images', 'error', `缺少 ${missing.length} 张本地图片`, missing.join('、')));
  }

  if (plainCount > 20_000) {
    issues.push(issue('length-over', 'error', '正文超过微信 2 万字限制', `当前约 ${plainCount} 字，需要删减后再发布。`));
  } else if (plainCount >= 18_000) {
    issues.push(issue('length-near', 'warning', '正文接近微信 2 万字限制', `当前约 ${plainCount} 字，建议预留修改空间。`));
  }

  const fm = parseFrontMatter(markdown);
  if (fm && !input.frontMatterEnabled) {
    issues.push(issue('frontmatter-theme', 'warning', '当前主题不会渲染文章属性', 'Front Matter 会保存在文件里，但不会生成头图、导语和签名组件。'));
  }

  const externalLinks = [...markdown.matchAll(/\[[^\]\n]+\]\((https?:\/\/[^\s)]+)[^)]*\)/gi)].length;
  if (externalLinks && !input.linkFootnotes) {
    issues.push(issue('external-links', 'warning', `发现 ${externalLinks} 个外部链接`, '公众号正文里的普通外链通常不可点击，建议在排版设置中开启“链接转脚注”。'));
  }

  const jumps = headingJumps(fm?.content ?? markdown);
  if (jumps.length) issues.push(issue('heading-jumps', 'warning', '标题层级存在跳级', jumps.slice(0, 3).join('；')));

  const placeholders = markdown.match(/(?:TODO|TBD|待补充|待确认|此处插入|XXX)/gi) ?? [];
  if (placeholders.length) {
    issues.push(issue('placeholders', 'warning', '正文可能还有待处理标记', `共发现 ${placeholders.length} 处 TODO、待补充或类似文字。`));
  }
  return issues;
}

/** Fields that only exist in the WeChat publishing dialog. */
export function checkPublishFields(input: PublishFieldInput): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const title = input.title.trim();
  if (!title) issues.push(issue('publish-title-empty', 'error', '缺少公众号标题', '标题是必填项。'));
  else if ([...title].length > 32) issues.push(issue('publish-title-long', 'error', '公众号标题超过 32 字', '请缩短标题后再推送。'));
  if ([...input.digest].length > 120) issues.push(issue('publish-digest-long', 'error', '摘要超过 120 字', '请缩短摘要后再推送。'));
  else if (!input.digest.trim()) issues.push(issue('publish-digest-empty', 'warning', '摘要为空', '微信会从正文开头自动截取，建议确认生成结果是否合适。'));
  if (!input.author.trim()) issues.push(issue('publish-author-empty', 'warning', '作者为空', '可以发布，但文章不会显示作者署名。'));
  if (!input.hasCover && !input.keepsExistingCover && !input.articleHasImage) {
    issues.push(issue('publish-cover-empty', 'error', '没有可用封面', '请选择封面，或先在正文中加入一张图片。'));
  }
  return issues;
}

export const hasBlockingIssues = (issues: readonly PreflightIssue[]) =>
  issues.some((item) => item.severity === 'error');
