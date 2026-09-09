import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../../i18n/testInstance';
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TodoList from './TodoList';

afterEach(() => {
  cleanup();
});

describe('TodoList', () => {
  it.each(['en', 'zh-CN'])('renders translated status badges in %s and omits priority badges', async (language) => {
    const i18n = await createTestI18n(language);
    render(
      <I18nextProvider i18n={i18n}><TodoList
        todos={[
          { id: 'a', content: 'Keep visible status', status: 'in_progress', priority: 'low' },
          { id: 'b', content: 'Hide priority badges', status: 'pending', priority: 'high' },
          { id: 'c', content: 'Finished work', status: 'completed', priority: 'medium' },
        ]}
      /></I18nextProvider>
    );

    expect(screen.getByText(i18n.t('uiText.taskStatus.in_progress'))).toBeTruthy();
    expect(screen.getByText(i18n.t('uiText.taskStatus.pending'))).toBeTruthy();
    expect(screen.getByText(i18n.t('uiText.taskStatus.completed'))).toBeTruthy();
    expect(screen.queryByText('low')).toBeNull();
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.queryByText('medium')).toBeNull();
  });
});
