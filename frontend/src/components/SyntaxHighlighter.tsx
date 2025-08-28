import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { createHighlighter, type Highlighter } from 'shiki';
import type { RootState } from '../store/store';

interface SyntaxHighlighterProps {
  code: string;
  language: string;
  className?: string;
}

// Theme mapping from Redux theme to Shiki theme
const THEME_MAP = {
  light: 'light-plus',
  dark: 'dark-plus',
} as const;

export function SyntaxHighlighter({
  code,
  language,
  className = '',
}: SyntaxHighlighterProps) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const [highlightedCode, setHighlightedCode] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  // Get theme from Redux store
  const reduxTheme = useSelector((state: RootState) => state.app.theme);

  useEffect(() => {
    let mounted = true;

    const initHighlighter = async () => {
      try {
        const shiki = await createHighlighter({
          themes: Object.values(THEME_MAP),
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
        // Use Redux theme directly
        const theme = THEME_MAP[reduxTheme];

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
  }, [highlighter, code, reduxTheme]);

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
