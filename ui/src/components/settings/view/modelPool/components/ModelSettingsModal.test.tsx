// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ModelSettingsModal from './ModelSettingsModal';
vi.mock('react-i18next', () => ({useTranslation: () => ({t:(key:string)=>key})}));
afterEach(cleanup);
const initial = {maxOutputTokens:8192,maxContextTokens:128000,supportsImage:false};
const props = () => ({modelId:'one',initial,testDisabled:false,onTest:vi.fn(),onCancelTest:vi.fn(),onSave:vi.fn(async()=>({ok:true})),onClose:vi.fn()});
const task = (imageInput: string) => ({id:'task',modelId:'one',providerId:'HXAPI',status:'success' as const,result:{models:[{modelId:'one',textInput:'supported',imageInput}]}});
it('does not overwrite a manual choice made while testing or by repeated polling', () => {
  const p = props();
  const {rerender} = render(<ModelSettingsModal {...p} task={{...task('unknown'),status:'testing'}} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('checkbox'));
  rerender(<ModelSettingsModal {...p} task={task('supported')} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  rerender(<ModelSettingsModal {...p} task={{...task('supported')}} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('keeps the previous image flag for an unknown result and changes only the draft on success', () => {
  const p = {...props(),initial:{...initial,supportsImage:true}};
  const {rerender} = render(<ModelSettingsModal {...p} task={task('unknown')} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  rerender(<ModelSettingsModal {...p} task={{...task('unsupported'),id:'next'}} />);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(p.onSave).not.toHaveBeenCalled();
});
it('validates positive integer token limits and keeps the dialog on save failure', async () => {
  const p = {...props(),onSave:vi.fn(async()=>({ok:false,error:'Conflict'}))};
  render(<ModelSettingsModal {...p} />);
  const save = screen.getByRole('button',{name:'pilotDeckConfig.panels.models.modelSettings.save'}) as HTMLButtonElement;
  const output = screen.getByLabelText('pilotDeckConfig.panels.models.maxOutputTokens');
  fireEvent.change(output,{target:{value:'1.5'}});expect(save.disabled).toBe(true);
  fireEvent.change(output,{target:{value:'0'}});expect(save.disabled).toBe(true);
  fireEvent.change(output,{target:{value:'16384'}});fireEvent.click(save);
  await screen.findByText('Conflict');expect(p.onClose).not.toHaveBeenCalled();
});
it('allows closing a running test without cancelling it', () => {
  const p = props();render(<ModelSettingsModal {...p} task={{...task('unknown'),status:'testing'}} />);
  fireEvent.click(screen.getByRole('button',{name:'confirmDialog.close'}));
  expect(p.onClose).toHaveBeenCalled();expect(p.onCancelTest).not.toHaveBeenCalled();
});
