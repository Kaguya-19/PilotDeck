import { File, FileSpreadsheet, FileText, X, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import {
  getDocumentSelectionSummary,
  type DocumentSelectionReference,
} from '../../types/documentSelection';

type DocumentReferenceFileMeta = {
  label: string;
  Icon: LucideIcon;
  className: string;
};

function getFileExtension(fileName: string): string {
  const cleanName = fileName.split(/[?#]/)[0] || fileName;
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : '';
  return (extension || '').toLowerCase();
}

function getDocumentReferenceFileMeta(fileName: string): DocumentReferenceFileMeta {
  const extension = getFileExtension(fileName);
  if (extension === 'pdf') {
    return {
      label: 'PDF',
      Icon: FileText,
      className: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300',
    };
  }
  if (['doc', 'docx', 'odt'].includes(extension)) {
    return {
      label: 'DOC',
      Icon: FileText,
      className: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
    };
  }
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(extension)) {
    return {
      label: 'XLS',
      Icon: FileSpreadsheet,
      className: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
    };
  }
  if (['ppt', 'pptx', 'odp'].includes(extension)) {
    return {
      label: 'PPT',
      Icon: FileText,
      className: 'bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300',
    };
  }
  return {
    label: extension ? extension.slice(0, 3).toUpperCase() : 'FILE',
    Icon: File,
    className: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  };
}

type DocumentReferenceChipProps = {
  reference: DocumentSelectionReference;
  className?: string;
  summaryLength?: number;
  removeLabel?: string;
  onRemove?: () => void;
};

export default function DocumentReferenceChip({
  reference,
  className,
  summaryLength = 80,
  removeLabel,
  onRemove,
}: DocumentReferenceChipProps) {
  const meta = getDocumentReferenceFileMeta(reference.fileName);
  const ReferenceIcon = meta.Icon;
  const summary = getDocumentSelectionSummary(reference, summaryLength);
  const title = [
    reference.fileName,
    reference.pageNumbers.length ? `p. ${reference.pageNumbers.join(', ')}` : null,
    summary,
  ].filter(Boolean).join('\n');

  return (
    <div
      className={cn(
        'flex h-8 min-w-0 max-w-full items-center gap-2 rounded-lg bg-neutral-100 px-2.5 text-left text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300',
        className,
      )}
      title={title}
      aria-label={title}
    >
      <span
        className={cn(
          'flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] font-semibold leading-none',
          meta.className,
        )}
      >
        <ReferenceIcon className="h-3 w-3" strokeWidth={2} />
        {meta.label}
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] leading-5">
        &quot;{summary}&quot;
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          title={removeLabel}
          aria-label={removeLabel}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
