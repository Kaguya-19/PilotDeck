import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../../i18n/testInstance';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionPanel } from './AskUserQuestionPanel';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AskUserQuestionPanel IME behavior', () => {
  it.each(['en', 'zh-CN'])('does not submit an IME confirmation in %s', async (language) => {
    const i18n = await createTestI18n(language);
    const onDecision = vi.fn();
    const request = {
      requestId: 'request-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Choose a path',
            options: [{ label: 'Default', description: 'Use the default path' }],
          },
        ],
      },
    };

    render(<I18nextProvider i18n={i18n}><AskUserQuestionPanel request={request} onDecision={onDecision} /></I18nextProvider>);

    fireEvent.click(screen.getByText(i18n.t('uiText.other')));
    const otherInput = screen.getByPlaceholderText(i18n.t('uiText.typeAnswer'));
    fireEvent.change(otherInput, { target: { value: 'nihao' } });

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
    });
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    });

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(
      'request-1',
      expect.objectContaining({
        allow: true,
        updatedInput: expect.objectContaining({
          answers: { 'Choose a path': 'nihao' },
        }),
      }),
    );
  });
});
