import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ResponseVariant } from '../api/types';
import { NewVariantDialog } from './NewVariantDialog';

const selectedVariant: ResponseVariant = {
  id: 'var_1',
  endpointId: 'ep_1',
  name: 'Allowed',
  status: 200,
  responseHeaders: {},
  revision: 1,
};

describe('NewVariantDialog', () => {
  it('requires a trimmed name, defaults to clone, and supports blank creation', async () => {
    const onConfirm = vi.fn();
    render(
      <NewVariantDialog
        isOpen
        selectedVariant={selectedVariant}
        loading={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Create Variant' });
    expect(screen.getByRole('radio', { name: 'Clone selected Variant' })).toBeChecked();
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText('New Variant name'), '   ');
    expect(confirm).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('New Variant name'));
    await userEvent.type(screen.getByLabelText('New Variant name'), '  Fresh response  ');
    await userEvent.click(screen.getByRole('radio', { name: 'Blank Variant' }));
    await userEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith({ name: 'Fresh response', source: 'blank' });
  });

  it('defaults to blank without a selected Variant and disables both actions while loading', () => {
    render(
      <NewVariantDialog
        isOpen
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: 'Blank Variant' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create Variant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('owns focus and background interaction, then restores its connected opener', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const view = render(
      <>
        <button type="button">Open new Variant</button>
        <NewVariantDialog
          isOpen={false}
          selectedVariant={selectedVariant}
          loading={false}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open new Variant' });
    opener.focus();
    view.rerender(
      <>
        <button type="button">Open new Variant</button>
        <NewVariantDialog
          isOpen
          selectedVariant={selectedVariant}
          loading={false}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'New Variant' });
    expect(opener).toHaveAttribute('inert');
    expect(screen.getByLabelText('New Variant name')).toHaveFocus();
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    }
    fireEvent.click(view.container.querySelector('.bg-black')!);
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(
      <>
        <button type="button">Open new Variant</button>
        <NewVariantDialog
          isOpen={false}
          selectedVariant={selectedVariant}
          loading={false}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </>,
    );
    expect(opener).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
  });

  it('keeps focus in the modal and blocks dismissal while loading', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { container } = render(
      <NewVariantDialog
        isOpen
        selectedVariant={selectedVariant}
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'New Variant' });

    expect(dialog).toHaveFocus();
    await user.tab();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(container.querySelector('.bg-black')!);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
