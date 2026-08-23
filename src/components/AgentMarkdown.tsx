import { Suspense, lazy } from 'react';

/**
 * What the agent said, rendered as markdown.
 *
 * It writes markdown to begin with — lists, `file names`, bolded points.
 * Pasted through as plain text that is a screenful of asterisks and backticks,
 * harder to read than not showing it at all. So on this timeline only the
 * agent's own speech takes this path; your line, the tool lines and the errors
 * stay plain text (they were never markdown anyway).
 *
 * This uses streamdown rather than reusing the article's markdown-it pipeline.
 * That pipeline's job is "lay out a finished draft in a shape WeChat will
 * accept" — every style inlined, images round-tripped through a remote host —
 * and its rules are set by WeChat, not by a 330px panel. The job here is a
 * different one: a sentence that is still growing, where half-typed `**bold`
 * and an unclosed ``` are what the previous frame looked like. streamdown
 * closes those provisionally, so you see bold text instead of two asterisks
 * waiting for the rest of the sentence to rescue them.
 *
 * Highlighting, math and mermaid are all left off: in a panel this narrow a
 * code block is "here is something it showed me", not something to read.
 * Enabling them would only drag shiki and mermaid into the bundle.
 *
 * The controls (copy, download, fullscreen) are off too, along with the link
 * confirmation popup — streamdown's skin is Tailwind class names, this project
 * has no Tailwind, and those classes land as nothing, so what pops up would be
 * an unstyled heap. The styling it should have is written by hand in
 * styles.css, keyed on data-streamdown.
 *
 * Loaded on demand: pressing this whole stack into first paint (unified plus a
 * full remark/rehype pipeline — rehype-raw alone drags in a parse5 bigger than
 * the main bundle) charges every launch where nobody used the agent. Fetch it
 * from disk once it actually says something; the fallback is the plain text of
 * that same sentence, which is what it looked like before anyway.
 */
const Streamdown = lazy(() => import('streamdown').then((m) => ({ default: m.Streamdown })));

export default function AgentMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={text}>
      <Streamdown
        className="agent-md"
        controls={false}
        lineNumbers={false}
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
    </Suspense>
  );
}
