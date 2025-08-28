import { useEffect, useState } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';

interface SyntaxHighlighterProps {
  code: string;
  language: string;
  className?: string;
}

export function SyntaxHighlighter({
  code,
  language,
  className = '',
}: SyntaxHighlighterProps) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const [highlightedCode, setHighlightedCode] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const initHighlighter = async () => {
      try {
        const shiki = await createHighlighter({
          themes: ['dark-plus', 'light-plus'],
          langs: ['json', 'solidity'],
        });

        if (mounted) {
          setHighlighter(shiki);
        }
      } catch {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    initHighlighter();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!highlighter || !code) {
      setIsLoading(false);
      return;
    }

    const updateHighlighting = () => {
      try {
        // Determine theme based on CSS variables or classes
        const isDarkMode =
          document.documentElement.classList.contains('theme-dark') ||
          document.body.classList.contains('theme-dark') ||
          window
            .getComputedStyle(document.documentElement)
            .getPropertyValue('--bg-base')
            .trim() === '#000000';

        const theme = isDarkMode ? 'dark-plus' : 'light-plus';

        const highlighted = highlighter.codeToHtml(code, {
          lang: language,
          theme: theme,
        });

        setHighlightedCode(highlighted);
      } catch {
        // Silently handle highlighting errors
      } finally {
        setIsLoading(false);
      }
    };

    updateHighlighting();

    // Listen for theme changes
    const observer = new MutationObserver(() => {
      updateHighlighting();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, [highlighter, code]);

  if (isLoading) {
    return (
      <pre
        className={`bg-[var(--surface-2)] p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap text-[var(--text)] ${className}`}
      >
        {code}
      </pre>
    );
  }

  if (!highlighter || !highlightedCode) {
    // Fallback to unstyled code if highlighting fails
    return (
      <pre
        className={`bg-[var(--surface-2)] p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap text-[var(--text)] ${className}`}
      >
        {code}
      </pre>
    );
  }

  return (
    <div
      className={`bg-[var(--surface-2)] p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto [&>pre]:!bg-transparent [&>pre]:!p-0 [&>pre]:!m-0 [&>pre]:!border-0 [&>pre]:!rounded-none ${className}`}
      dangerouslySetInnerHTML={{ __html: highlightedCode }}
    />
  );
}
