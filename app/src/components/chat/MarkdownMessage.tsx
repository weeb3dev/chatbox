import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Components } from "react-markdown";

const markdownComponents: Components = {
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return <ul className="mb-2 list-disc space-y-1 pl-4 last:mb-0">{children}</ul>;
  },
  ol({ children }) {
    return (
      <ol className="mb-2 list-decimal space-y-1 pl-4 last:mb-0">{children}</ol>
    );
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  h1({ children }) {
    return <h1 className="mb-2 text-base font-semibold">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 text-sm font-semibold">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1 text-sm font-medium">{children}</h3>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="mb-2 border-l-2 border-accent/50 pl-3 text-gray-400 italic">
        {children}
      </blockquote>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-accent-light underline decoration-accent-light/40 underline-offset-2 hover:text-accent"
        target="_blank"
        rel="noreferrer noopener"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="border-b border-border">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody className="divide-y divide-border/50">{children}</tbody>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  th({ children }) {
    return (
      <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-300">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-3 py-1.5 text-xs text-gray-400">{children}</td>
    );
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const code = String(children).replace(/\n$/, "");
    const isBlock = match != null || code.includes("\n");

    if (isBlock && match) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: "0.5rem 0",
            borderRadius: "0.5rem",
            fontSize: "0.8rem",
            border: "1px solid var(--color-border)",
          }}
        >
          {code}
        </SyntaxHighlighter>
      );
    }

    if (isBlock) {
      return (
        <SyntaxHighlighter
          style={oneDark}
          language="text"
          PreTag="div"
          customStyle={{
            margin: "0.5rem 0",
            borderRadius: "0.5rem",
            fontSize: "0.8rem",
            border: "1px solid var(--color-border)",
          }}
        >
          {code}
        </SyntaxHighlighter>
      );
    }

    return (
      <code
        className="rounded bg-surface px-1 py-0.5 font-mono text-[0.85em] text-accent-light"
        {...props}
      >
        {children}
      </code>
    );
  },
};

export default function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed break-words text-gray-200 [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
