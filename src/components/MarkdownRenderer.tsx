import { isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { Check, Code2, Copy, Download, Eye } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function extractTextFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromNode).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props?.children !== undefined) {
    return extractTextFromNode(node.props.children);
  }
  return '';
}

function sanitizeSafeHref(href?: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const match = /language-([\w-]+)/.exec(className || '');
  const language = (match?.[1] ?? '').toLowerCase();
  const codeText = extractTextFromNode(children).replace(/\n$/, '');
  const canPreview = language === 'svg' || language === 'html';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleDownload = () => {
    const ext = language === 'svg' ? 'svg' : language === 'html' ? 'html' : language || 'txt';
    const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `lumen-snippet.${ext}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const previewSrcDoc =
    language === 'svg'
      ? `<!doctype html><html><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#ffffff;padding:16px;box-sizing:border-box;">${codeText}</body></html>`
      : codeText;

  return (
    <div className="my-3 max-w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-950 text-slate-100 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/90 px-3.5 py-2 text-xs text-slate-400">
        <span className="font-mono truncate">{language || 'code'}</span>
        <div className="flex items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={() => setShowPreview((p) => !p)}
              className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap shrink-0"
              aria-label={showPreview ? 'View code' : 'Preview visual'}
            >
              {showPreview ? (
                <>
                  <Code2 className="h-3.5 w-3.5" />
                  <span>Code</span>
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" />
                  <span>Preview</span>
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap shrink-0"
            aria-label="Download code snippet"
            title="Download"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex min-h-[30px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap shrink-0"
            aria-label="Copy code snippet"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {showPreview && canPreview ? (
        <div className="bg-white p-2">
          <iframe
            sandbox=""
            title="Sandboxed visual preview"
            srcDoc={previewSrcDoc}
            className="h-72 w-full rounded-lg border border-slate-200 bg-white"
          />
        </div>
      ) : (
        <pre className="max-w-full overflow-x-auto p-3 sm:p-3.5 text-[12.5px] sm:text-[13px] leading-relaxed">
          <code className={className ? `${className} hljs` : 'hljs'}>{children}</code>
        </pre>
      )}
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-lg sm:text-xl font-semibold tracking-tight text-slate-900 dark:text-white">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-base sm:text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[15px] sm:text-base font-semibold text-slate-900 dark:text-white">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</p>
  ),
  ul: ({ children }) => <ul className="list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1.5 pl-5">{children}</ol>,
  li: ({ children }) => (
    <li className="leading-relaxed break-words [overflow-wrap:anywhere]">{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-slate-700 italic dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    const safeHref = sanitizeSafeHref(href);
    if (!safeHref) {
      return <span className="text-slate-600 dark:text-slate-400">{children}</span>;
    }
    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-blue-600 underline decoration-blue-600/40 underline-offset-2 transition-colors hover:text-blue-700 break-words [overflow-wrap:anywhere] dark:text-blue-400 dark:hover:text-blue-300"
      >
        {children}
      </a>
    );
  },
  hr: () => <hr className="my-4 border-slate-200 dark:border-slate-800" />,
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full border-collapse text-left text-xs sm:text-sm tabular-nums">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
      {children}
    </thead>
  ),
  th: ({ children }) => <th className="px-3 py-2 sm:px-3.5 sm:py-2.5">{children}</th>,
  td: ({ children }) => (
    <td className="border-t border-slate-200 px-3 py-2 sm:px-3.5 sm:py-2.5 dark:border-slate-800">
      {children}
    </td>
  ),
  code: ({ className, children, ...props }) => {
    const plain = extractTextFromNode(children);
    const isBlock = Boolean(className?.includes('language-')) || Boolean(className?.includes('hljs')) || plain.includes('\n');
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code
        className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12.5px] sm:text-[13px] text-slate-900 break-words [overflow-wrap:anywhere] dark:border-slate-800 dark:bg-slate-800/80 dark:text-slate-100"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
};

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="min-w-0 max-w-full space-y-3 text-[15px] leading-[1.65] text-slate-800 dark:text-slate-200">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
