// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyHtmlToClipboard, copyTextToClipboard } from './clipboard';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('block clipboard support', () => {
  it('writes both HTML and plain text for rich table pasting', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write } });
    const items: Record<string, Blob>[] = [];
    vi.stubGlobal('ClipboardItem', class {
      constructor(data: Record<string, Blob>) { items.push(data); }
    });
    expect(await copyHtmlToClipboard('<table><tr><td>A</td></tr></table>', 'A')).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(items[0]['text/html'].type).toBe('text/html');
    expect(items[0]['text/plain'].type).toBe('text/plain');
    const read = (blob: Blob) => new Promise((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob);
    });
    expect(await read(items[0]['text/html'])).toBe('<table><tr><td>A</td></tr></table>');
    expect(await read(items[0]['text/plain'])).toBe('A');
  });

  it('falls back to TSV if a browser refuses rich clipboard writes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new Error('denied')), writeText } });
    vi.stubGlobal('ClipboardItem', class {});
    expect(await copyHtmlToClipboard('<table></table>', 'A\tB\n1\t2')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('A\tB\n1\t2');
  });

  it('supports copying over an insecure local deployment with no Clipboard API', async () => {
    vi.stubGlobal('isSecureContext', false);
    const exec = vi.fn(() => {
      expect((document.activeElement as HTMLTextAreaElement).value).toBe(String.raw`\ref{test}\n`);
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    expect(await copyTextToClipboard(String.raw`\ref{test}\n`)).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    Reflect.deleteProperty(document, 'execCommand');
  });
});
