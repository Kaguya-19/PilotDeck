import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImageCapabilityModal from './ImageCapabilityModal';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
describe('manual image capability drafts', () => {
  it('keeps selections across equivalent lists and unrelated parent rerenders', () => {
    const onConfirm = vi.fn();
    const props = { onConfirm, onCancel: vi.fn() };
    const view = render(<ImageCapabilityModal key="task-a" modelIds={['one', 'two']} {...props} />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'connection.manualUnsupported' })[0]);
    for (let i = 0; i < 4; i++) {
      view.rerender(<ImageCapabilityModal key="task-a" modelIds={['one', 'two']} {...props} />);
      expect((screen.getAllByRole('radio', { name: 'connection.manualUnsupported' })[0] as HTMLInputElement).checked).toBe(true);
    }
    fireEvent.click(screen.getAllByRole('radio', { name: 'connection.manualSupported' })[1]);
    view.rerender(<ImageCapabilityModal key="task-a" modelIds={['one', 'two']} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'connection.manualConfirm' }));
    expect(onConfirm).toHaveBeenCalledWith({ one: false, two: true });
    view.rerender(<ImageCapabilityModal key="task-b" modelIds={['one', 'two']} {...props} />);
    expect(screen.getAllByRole('radio').every(radio => !(radio as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole('button', { name: 'connection.manualConfirm' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('preserves retained choices when model membership changes, and does not restore removed choices', () => {
    const props = { onConfirm: vi.fn(), onCancel: vi.fn() };
    const view = render(<ImageCapabilityModal modelIds={['one', 'two']} {...props} />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'connection.manualSupported' })[0]);
    fireEvent.click(screen.getAllByRole('radio', { name: 'connection.manualUnsupported' })[1]);
    view.rerender(<ImageCapabilityModal modelIds={['two', 'three']} {...props} />);
    expect((screen.getAllByRole('radio', { name: 'connection.manualUnsupported' })[0] as HTMLInputElement).checked).toBe(true);
    view.rerender(<ImageCapabilityModal modelIds={['one', 'two']} {...props} />);
    expect((screen.getAllByRole('radio', { name: 'connection.manualSupported' })[0] as HTMLInputElement).checked).toBe(false);
  });
});
