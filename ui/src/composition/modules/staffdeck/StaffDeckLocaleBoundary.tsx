import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import sourceTranslations from './staffdeck-source-translations.json';

type Locale = 'en' | 'zh-CN';
type Template = { pattern: RegExp; slots: number[]; target: string };

const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'] as const;
const TOKEN = /\{(\d+)\}/g;
const exact = new Map(Object.entries(sourceTranslations as Record<string, string>));
const templates: Template[] = [];

for (const [source, target] of exact) {
  if (!TOKEN.test(source)) {
    TOKEN.lastIndex = 0;
    continue;
  }
  TOKEN.lastIndex = 0;
  let cursor = 0;
  let pattern = '^';
  const slots: number[] = [];
  for (const match of source.matchAll(TOKEN)) {
    pattern += escapeRegExp(source.slice(cursor, match.index));
    pattern += '([\\s\\S]*?)';
    slots.push(Number(match[1]));
    cursor = (match.index || 0) + match[0].length;
  }
  pattern += `${escapeRegExp(source.slice(cursor))}$`;
  templates.push({ pattern: new RegExp(pattern), slots, target });
}

templates.sort((left, right) => right.pattern.source.length - left.pattern.source.length);

const textSources = new WeakMap<Text, string>();
const attributeSources = new WeakMap<Element, Map<string, string>>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitWhitespace(value: string): [string, string, string] {
  const leading = value.match(/^\s*/)?.[0] || '';
  const trailing = value.match(/\s*$/)?.[0] || '';
  return [leading, value.slice(leading.length, value.length - trailing.length), trailing];
}

function translate(source: string): string | null {
  const direct = exact.get(source);
  if (direct) return direct;
  for (const template of templates) {
    const match = source.match(template.pattern);
    if (!match) continue;
    return template.target.replace(TOKEN, (_, slot: string) => match[template.slots.indexOf(Number(slot)) + 1] || '');
  }
  return null;
}

function translateWhitespace(source: string): string {
  const [leading, core, trailing] = splitWhitespace(source);
  if (!core) return source;
  const translated = translate(core);
  return translated ? `${leading}${translated}${trailing}` : source;
}

function ignored(element: Element | null): boolean {
  return Boolean(element?.closest('code, pre, script, style, textarea, [contenteditable="true"], [data-i18n-ignore]'));
}

function localizeText(node: Text, locale: Locale): void {
  if (ignored(node.parentElement)) return;
  const current = node.data;
  const source = textSources.get(node);
  const previousTarget = source ? translateWhitespace(source) : '';
  if (locale === 'zh-CN') {
    if (source && current === previousTarget && current !== source) node.data = source;
    else if (!source || (current !== source && current !== previousTarget)) textSources.set(node, current);
    return;
  }
  const original = source && (current === source || current === previousTarget) ? source : current;
  textSources.set(node, original);
  const target = translateWhitespace(original);
  if (target !== current) node.data = target;
}

function localizeAttribute(element: Element, name: string, locale: Locale): void {
  if (ignored(element) || (name === 'title' && element.hasAttribute('data-i18n-ignore-title'))) return;
  const current = element.getAttribute(name);
  if (current == null) return;
  let sources = attributeSources.get(element);
  if (!sources) {
    sources = new Map();
    attributeSources.set(element, sources);
  }
  const source = sources.get(name);
  const previousTarget = source ? translateWhitespace(source) : '';
  if (locale === 'zh-CN') {
    if (source && current === previousTarget && current !== source) element.setAttribute(name, source);
    else if (!source || (current !== source && current !== previousTarget)) sources.set(name, current);
    return;
  }
  const original = source && (current === source || current === previousTarget) ? source : current;
  sources.set(name, original);
  const target = translateWhitespace(original);
  if (target !== current) element.setAttribute(name, target);
}

function localize(root: HTMLElement, locale: Locale): void {
  localizeElement(root, locale);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) localizeText(node as Text, locale);
    else localizeElement(node as Element, locale);
    node = walker.nextNode();
  }
}

function localizeElement(element: Element, locale: Locale): void {
  for (const name of ATTRIBUTES) localizeAttribute(element, name, locale);
}

/** Applies StaffDeck's source-string catalog only inside the vendored business UI. */
export default function StaffDeckLocaleBoundary({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const locale: Locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en';

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const refresh = () => {
      localize(root, locale);
      // Only the public formal Host's labelled Portal roots. Never walk the
      // native shell, another module's dialog or arbitrary document content.
      document.querySelectorAll<HTMLElement>('[data-staffdeck-portal-root="true"]').forEach(portal => localize(portal, locale));
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRIBUTES] });
    return () => observer.disconnect();
  }, [locale]);

  return <div ref={rootRef} data-staffdeck-locale-root="true" style={{ display: 'contents' }}>{children}</div>;
}
