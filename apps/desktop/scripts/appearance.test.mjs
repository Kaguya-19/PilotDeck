import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/appearance.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', compiled)(mod, mod.exports, require);
const { normalizeAppearance, renderLoadingHtml, startupText } = mod.exports;

test('missing and malformed appearance uses system theme and OS language', () => {
  assert.deepEqual(normalizeAppearance(null, 'zh-Hans-CN'), { language: 'zh-CN', themeMode: 'system' });
  assert.deepEqual(normalizeAppearance({ language: '<script>', themeMode: 'bad' }, 'en-US'), { language: 'en', themeMode: 'system' });
  assert.deepEqual(normalizeAppearance({ language: 'en', themeMode: 'light' }, 'zh-CN'), { language: 'en', themeMode: 'light' });
});
test('startup UI translates controls and statuses while preserving diagnostic details', () => {
  const html = renderLoadingHtml({ language: 'zh-CN', themeMode: 'dark' });
  assert.match(html, /lang="zh-CN" data-theme="dark"/);
  assert.match(html, />重试<\/button>/);
  assert.match(html, />打开日志<\/button>/);
  assert.equal(startupText('Checking local configuration...', 'zh-CN'), '正在检查本地配置…');
  assert.equal(startupText('EACCES: /custom/path', 'zh-CN'), 'EACCES: /custom/path');
  const light = renderLoadingHtml({ language: 'en', themeMode: 'light' });
  assert.match(light, /data-theme="light"/);
  assert.match(light, />Retry<\/button>/);
  assert.match(light, /prefers-color-scheme: dark/);
});
