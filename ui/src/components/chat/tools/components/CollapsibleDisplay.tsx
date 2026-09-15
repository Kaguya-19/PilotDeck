import { useTranslation } from 'react-i18next';
import React from 'react';
import { CollapsibleSection } from './CollapsibleSection';

interface CollapsibleDisplayProps {
  toolName: string;
  toolId?: string;
  title: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  action?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  showRawParameters?: boolean;
  rawContent?: string;
  className?: string;
  toolCategory?: string;
  autoExpandable?: boolean;
}

export const CollapsibleDisplay: React.FC<CollapsibleDisplayProps> = ({
  toolName,
  title,
  defaultOpen = false,
  open,
  onOpenChange,
  action,
  onTitleClick,
  children,
  showRawParameters = false,
  rawContent,
  className = '',
  toolCategory,
  autoExpandable = true
}) => {
  const { t } = useTranslation('common');

  return (
    <div className={`my-1 min-w-0 py-0.5 ${className}`}>
      <CollapsibleSection
        title={title}
        toolName={toolName}
        open={open ?? defaultOpen}
        onOpenChange={onOpenChange}
        action={action}
        onTitleClick={onTitleClick}
        autoExpandable={autoExpandable}
      >
        {children}

        {showRawParameters && rawContent && (
          <details className="group/raw relative mt-2">
            <summary className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11px] text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
              <svg
                className="h-2.5 w-2.5 transition-transform duration-150 group-open/raw:rotate-90"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {t('common:uiText.rawParams')}
            </summary>
            <pre className="mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-gray-200/40 bg-gray-50 p-2 font-mono text-[11px] text-gray-600 dark:border-gray-700/40 dark:bg-gray-900/50 dark:text-gray-400">
              {rawContent}
            </pre>
          </details>
        )}
      </CollapsibleSection>
    </div>
  );
};
