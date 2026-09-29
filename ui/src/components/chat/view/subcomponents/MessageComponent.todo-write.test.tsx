// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../types/types';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../i18n/testInstance';
import MessageComponent from './MessageComponent';

afterEach(() => {
  cleanup();
});

async function renderToolMessage(message: ChatMessage) {
  const i18n = await createTestI18n();
  return render(
    <I18nextProvider i18n={i18n}><MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="pilotdeck"
      onShowSettings={() => {}}
    /></I18nextProvider>,
  );
}

describe('MessageComponent todo_write rendering', () => {
  it('renders markdown checklist details for lowercase todo_write tool calls', async () => {
    await renderToolMessage({
      id: 'todo-tool-1',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'todo_write',
      toolId: 'todo-tool-1',
      toolInput: {
        markdown: ['- [x] Create project directory structure', '- [ ] Implement game constants'].join('\n'),
      },
    });

    const summary = screen.getByText('Updating todo list').closest('summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText('Create project directory structure')).toBeTruthy();
    expect(screen.getByText('Implement game constants')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
  });

  it('renders TodoWrite success result message', async () => {
    await renderToolMessage({
      id: 'todo-tool-2',
      type: 'assistant',
      content: '',
      timestamp: '2026-05-18T08:00:00.000Z',
      isToolUse: true,
      toolName: 'TodoWrite',
      toolId: 'todo-tool-2',
      toolInput: {
        markdown: '- [ ] Create project directory structure',
      },
      toolResult: {
        isError: false,
        content: 'Todo list updated',
      },
    });

    expect(screen.getAllByText('Todo list updated').length).toBeGreaterThan(0);
  });
});
