// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FolderBrowserModal from './FolderBrowserModal';

const mocks = vi.hoisted(() => ({
  language: 'zh-CN',
  browseFilesystemFolders: vi.fn(),
  createFolderInFilesystem: vi.fn(),
}));

vi.mock('../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));

vi.mock('react-i18next', async () => {
  const enCommon = (await import('../../../i18n/locales/en/common.json')).default as Record<string, unknown>;
  const zhCommon = (await import('../../../i18n/locales/zh-CN/common.json')).default as Record<string, unknown>;
  const lookupTranslation = (resources: Record<string, unknown>, key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined),
      resources,
    );
    return typeof value === 'string' ? value : key;
  };
  const t = (key: string) => lookupTranslation(mocks.language === 'zh-CN' ? zhCommon : enCommon, key);

  return {
    useTranslation: () => ({
      t,
      i18n: { language: mocks.language, changeLanguage: vi.fn() },
    }),
  };
});

vi.mock('../data/workspaceApi', () => ({
  browseFilesystemFolders: mocks.browseFilesystemFolders,
  createFolderInFilesystem: mocks.createFolderInFilesystem,
}));

describe('FolderBrowserModal', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.language = 'zh-CN';
    mocks.browseFilesystemFolders.mockImplementation(async (path: string) => path !== '~' && path !== 'C:\\Users\\wukai' ? { path, suggestions: [] } : ({
      path: 'C:\\Users\\wukai',
      suggestions: [{ name: 'Desktop', path: 'C:\\Users\\wukai\\Desktop' }],
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders Chinese copy when the interface language is zh-CN', async () => {
    render(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: '选择文件夹' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Desktop' })[0]).toBeTruthy();
    });
    expect(screen.getByText('路径：')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '使用此文件夹' })).toBeTruthy();
  });

  it('renders English copy when the interface language is en', async () => {
    mocks.language = 'en';
    render(
      <FolderBrowserModal
        isOpen
        autoAdvanceOnSelect={false}
        onClose={vi.fn()}
        onFolderSelected={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Select Folder' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Desktop' })[0]).toBeTruthy();
    });
    expect(screen.getByText('Path:')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeTruthy();
  });
});


describe('folder navigation', () => {
  const child = (name: string) => ({ name, path: '/home/' + name });
  const renderPicker = (initialPath?: string) => {
    const selected = vi.fn();
    render(<StrictMode><FolderBrowserModal isOpen initialPath={initialPath} autoAdvanceOnSelect onClose={vi.fn()} onFolderSelected={selected} /></StrictMode>);
    return selected;
  };
  beforeEach(() => {
    localStorage.clear(); mocks.language = 'en';
    mocks.browseFilesystemFolders.mockImplementation(async (path: string) => ({path: path === '~' ? '/home' : path, suggestions: path === '~' || path === '/home' ? [child('Alpha'), child('Beta'), child('.hidden')] : []}));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('initializes an explicit path under StrictMode without user navigation', async () => {
    const selected = renderPicker('/home/Beta');
    await screen.findByRole('region', { name: '/home/Beta' });
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    expect(selected).toHaveBeenCalledWith('/home/Beta', true);
  });
  it('keeps the parent column and selects only on confirmation', async () => {
    const selected = renderPicker();
    fireEvent.click(await screen.findByRole('button', {name: 'Alpha'}));
    await screen.findByRole('region', {name: '/home/Alpha'});
    expect(screen.getByRole('button', {name: 'Beta'})).toBeTruthy();
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Use this folder'}));
    expect(selected).toHaveBeenCalledWith('/home/Alpha', true);
    expect(JSON.parse(localStorage.getItem('pilotdeck.folder-picker.v1:1')!).recent).toEqual(['/home/Alpha']);
  });
  it('filters just the current directory and reveals hidden folders', async () => {
    renderPicker(); await screen.findByRole('button', {name: 'Alpha'});
    fireEvent.change(screen.getByRole('textbox', {name: 'Filter this folder'}), {target:{value:'beta'}});
    expect(screen.queryByRole('button', {name:'Alpha'})).toBeNull();
    expect(screen.getByRole('button', {name:'Beta'})).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', {name: 'Filter this folder'}), {target:{value:''}});
    expect(screen.queryByRole('button', {name:'.hidden'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name:'Show hidden folders'}));
    expect(screen.getByRole('button', {name:'.hidden'})).toBeTruthy();
  });
  it('ignores a late response when another sibling was opened', async () => {
    let resolveAlpha!: (value: unknown) => void;
    const normal = mocks.browseFilesystemFolders.getMockImplementation()!;
    mocks.browseFilesystemFolders.mockImplementation((path: string) => path === '/home/Alpha' ? new Promise(resolve => {resolveAlpha = resolve;}) : normal(path));
    const selected = renderPicker();
    fireEvent.click(await screen.findByRole('button', {name:'Alpha'}));
    fireEvent.click(screen.getByRole('button', {name:'Beta'}));
    await screen.findByRole('region', {name:'/home/Beta'});
    resolveAlpha({path:'/home/Alpha',suggestions:[]});
    await waitFor(() => expect(screen.queryByRole('region', {name:'/home/Alpha'})).toBeNull());
    fireEvent.click(screen.getByRole('button', {name:'Use this folder'}));
    expect(selected).toHaveBeenCalledWith('/home/Beta', true);
  });
  it('supports address jumps and history without recursive requests', async () => {
    renderPicker(); await screen.findByRole('button', {name:'Alpha'});
    fireEvent.click(screen.getByRole('button', {name:'Enter folder path'}));
    const address = screen.getByRole('textbox', {name:'Enter folder path'});
    fireEvent.change(address,{target:{value:'/home/Beta'}});fireEvent.keyDown(address,{key:'Enter'});
    await screen.findByRole('region', {name:'/home/Beta'});
    fireEvent.click(screen.getByRole('button', {name:'Back'}));
    await waitFor(() => expect(screen.queryByRole('region', {name:'/home/Beta'})).toBeNull());
    fireEvent.click(screen.getByRole('button', {name:'Forward'}));
    await screen.findByRole('region', {name:'/home/Beta'});
    expect(mocks.browseFilesystemFolders.mock.calls.filter(([p]) => p === '/home/Beta')).toHaveLength(1);
  });
  it('falls back to home when a remembered directory no longer exists', async () => {
    localStorage.setItem('pilotdeck.folder-picker.v1:1', JSON.stringify({recent:['/missing']}));
    const normal=mocks.browseFilesystemFolders.getMockImplementation()!;
    mocks.browseFilesystemFolders.mockImplementation((path:string) => path === '/missing' ? Promise.reject(Error('missing')) : normal(path));
    renderPicker();await screen.findByRole('button',{name:'Alpha'});
    expect(screen.getByRole('button',{name:'Use this folder'}).hasAttribute('disabled')).toBe(false);
  });
});


describe('folder creation and keyboard interaction', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.language='en';
    mocks.browseFilesystemFolders.mockImplementation(async (path:string) => ({path:path==='~'?'/home':path,suggestions:(path==='~'||path==='/home')?[{name:'Parent',path:'/home/Parent'}]:[]}));
  });
  afterEach(() => {cleanup();vi.clearAllMocks();});
  it('opens a child with the keyboard and keeps focus inside the browser', async () => {
    render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={vi.fn()} />);
    const parent=await screen.findByRole('button',{name:'Parent'});parent.focus();fireEvent.keyDown(parent,{key:'ArrowRight'});
    const child=await screen.findByRole('region',{name:'/home/Parent'});
    await waitFor(()=>expect(document.activeElement).toBe(child));
  });
  it('creates a folder inside the displayed directory and opens it', async () => {
    mocks.createFolderInFilesystem.mockResolvedValue('/home/New folder');
    const select=vi.fn();render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={select} />);
    await screen.findByRole('button',{name:'Parent'});
    fireEvent.click(screen.getByRole('button',{name:'Create new folder'}));
    fireEvent.change(screen.getByRole('textbox',{name:'New folder name'}),{target:{value:'New folder'}});
    fireEvent.click(screen.getByRole('button',{name:'Create'}));
    await screen.findByRole('region',{name:'/home/New folder'});
    expect(mocks.createFolderInFilesystem).toHaveBeenCalledWith('/home/New folder');
    fireEvent.click(screen.getByRole('button',{name:'Use this folder'}));expect(select).toHaveBeenCalledWith('/home/New folder',false);
  });
  it('does not allow selecting the synthetic Windows drive root', async () => {
    mocks.browseFilesystemFolders.mockResolvedValue({path:'/',rootsPath:'/',suggestions:[{name:'C:',path:'C:\\',type:'drive'}]});
    render(<FolderBrowserModal isOpen autoAdvanceOnSelect={false} onClose={vi.fn()} onFolderSelected={vi.fn()} />);
    await screen.findByRole('button',{name:'C:'});
    expect(screen.getByRole('button',{name:'Use this folder'}).hasAttribute('disabled')).toBe(true);
  });
});
