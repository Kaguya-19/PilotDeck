export const DOCUMENT_SELECTION_ATTACHMENT_KIND = 'document-selection';
export const DOCUMENT_SELECTION_PROMPT_MARKER = '[Document selections quoted by user:]';

const MAX_SELECTED_TEXT_LENGTH = 8000;
const MAX_SURROUNDING_TEXT_LENGTH = 1000;

export type DocumentSelectionSource = 'pdf' | 'office-pdf';

export type DocumentSelectionReference = {
  kind: typeof DOCUMENT_SELECTION_ATTACHMENT_KIND;
  id: string;
  projectName?: string;
  fileName: string;
  filePath: string;
  source: DocumentSelectionSource;
  pageNumbers: number[];
  selectedText: string;
  surroundingText?: string;
  occurrenceIndex?: number | null;
  createdAt: string;
  truncated?: boolean;
};

export type DocumentSelectionReferenceInput = Omit<
  DocumentSelectionReference,
  'kind' | 'id' | 'createdAt' | 'selectedText' | 'surroundingText' | 'truncated'
> & {
  id?: string;
  createdAt?: string;
  selectedText: string;
  surroundingText?: string;
  truncated?: boolean;
};

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): { text: string; truncated: boolean } {
  const text = value.trim();
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxLength).trimEnd()}...`, truncated: true };
}

function createReferenceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `docsel-${crypto.randomUUID()}`;
  }
  return `docsel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function basenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

export function createDocumentSelectionReference(
  input: DocumentSelectionReferenceInput,
): DocumentSelectionReference {
  const selected = truncateText(input.selectedText, MAX_SELECTED_TEXT_LENGTH);
  const surrounding = input.surroundingText
    ? truncateText(input.surroundingText, MAX_SURROUNDING_TEXT_LENGTH)
    : { text: '', truncated: false };

  return {
    ...input,
    kind: DOCUMENT_SELECTION_ATTACHMENT_KIND,
    id: input.id || createReferenceId(),
    createdAt: input.createdAt || new Date().toISOString(),
    fileName: input.fileName || basenameFromPath(input.filePath),
    pageNumbers: Array.from(new Set(input.pageNumbers.filter((page) => Number.isFinite(page) && page > 0))).sort((a, b) => a - b),
    selectedText: selected.text,
    ...(surrounding.text ? { surroundingText: surrounding.text } : {}),
    truncated: Boolean(input.truncated || selected.truncated || surrounding.truncated),
  };
}

export function isDocumentSelectionReference(value: unknown): value is DocumentSelectionReference {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as { kind?: unknown }).kind === DOCUMENT_SELECTION_ATTACHMENT_KIND
      && typeof (value as { selectedText?: unknown }).selectedText === 'string'
      && typeof (value as { filePath?: unknown }).filePath === 'string',
  );
}

function sanitizeQuotedBlock(value: string | undefined): string {
  return (value || '').replace(/"""/g, "'''").trim();
}

function formatPages(pageNumbers: number[]): string {
  return pageNumbers.length > 0 ? pageNumbers.join(', ') : 'unknown';
}

export function formatDocumentSelectionPromptBlock(
  references: DocumentSelectionReference[],
): string {
  const validReferences = references.filter(isDocumentSelectionReference);
  if (validReferences.length === 0) return '';

  const lines = [DOCUMENT_SELECTION_PROMPT_MARKER];
  lines.push('The File field is the exact document the user selected from. If the user asks to modify the selected content, use that File as the default target unless the user explicitly names another target file.');
  validReferences.forEach((reference, index) => {
    lines.push(`${index + 1}. File: ${reference.filePath}`);
    lines.push(`   Pages: ${formatPages(reference.pageNumbers)}`);
    lines.push('   Selected text:');
    lines.push(`   """${sanitizeQuotedBlock(reference.selectedText)}"""`);
    lines.push('   Surrounding context:');
    lines.push(`   """${sanitizeQuotedBlock(reference.surroundingText)}"""`);
    lines.push(`   Locator: occurrenceIndex=${reference.occurrenceIndex ?? 'unknown'}`);
  });

  return `\n\n${lines.join('\n')}`;
}

export function stripDocumentSelectionPromptBlock(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  const markerIndex = text.indexOf(DOCUMENT_SELECTION_PROMPT_MARKER);
  if (markerIndex < 0) return text;
  return text.slice(0, markerIndex).trimEnd();
}

export function parseDocumentSelectionPromptBlock(content: unknown): {
  content: string;
  references: DocumentSelectionReference[];
} {
  const text = typeof content === 'string' ? content : '';
  const markerIndex = text.indexOf(DOCUMENT_SELECTION_PROMPT_MARKER);
  if (markerIndex < 0) {
    return { content: text, references: [] };
  }

  const visibleContent = stripDocumentSelectionPromptBlock(text);
  const block = text.slice(markerIndex + DOCUMENT_SELECTION_PROMPT_MARKER.length).trim();
  const references: DocumentSelectionReference[] = [];
  const chunks = Array.from(block.matchAll(/(?:^|\n)(\d+\.\s+File:[\s\S]*?)(?=\n\d+\.\s+File:|$)/g))
    .map((match) => match[1]?.trim())
    .filter((chunk): chunk is string => Boolean(chunk));

  chunks.forEach((chunk) => {
    const filePath = chunk.match(/^\d+\.\s+File:\s*(.+)$/m)?.[1]?.trim() || '';
    const pagesRaw = chunk.match(/^\s*Pages:\s*(.+)$/m)?.[1]?.trim() || '';
    const selectedText = chunk.match(/^\s*Selected text:\s*\n\s*"""([\s\S]*?)"""/m)?.[1]?.trim() || '';
    const surroundingText = chunk.match(/^\s*Surrounding context:\s*\n\s*"""([\s\S]*?)"""/m)?.[1]?.trim() || '';
    const occurrenceRaw = chunk.match(/occurrenceIndex=([^\s]+)/)?.[1] || '';
    const occurrenceIndex = Number.parseInt(occurrenceRaw, 10);
    if (!filePath || !selectedText) return;

    const pageNumbers = pagesRaw
      .split(',')
      .map((page) => Number.parseInt(page.trim(), 10))
      .filter((page) => Number.isFinite(page) && page > 0);

    references.push(createDocumentSelectionReference({
      fileName: basenameFromPath(filePath),
      filePath,
      source: 'office-pdf',
      pageNumbers,
      selectedText,
      surroundingText,
      occurrenceIndex: Number.isFinite(occurrenceIndex) ? occurrenceIndex : null,
    }));
  });

  return { content: visibleContent, references };
}

export function getDocumentSelectionSummary(reference: DocumentSelectionReference, maxLength = 160): string {
  const normalized = normalizeSpaces(reference.selectedText);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}
