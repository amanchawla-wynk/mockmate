import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ResponseVariant, VariantDeletionImpact } from '../api/types';
import { VariantDeleteDialog } from './VariantDeleteDialog';

const variant: ResponseVariant = {
  id: 'var_2',
  endpointId: 'ep_1',
  name: 'Denied',
  status: 403,
  responseHeaders: {},
  revision: 2,
};

const referencedImpact: VariantDeletionImpact = {
  endpointId: 'ep_1',
  endpointRevision: 7,
  variantId: 'var_2',
  variantRevision: 5,
  isFallback: true,
  affectedStates: [
    { id: 'state_1', name: 'Signed out', revision: 3 },
    { id: 'state_2', name: 'Expired session', revision: 4 },
  ],
  replacementVariants: [
    { id: 'var_1', name: 'Allowed', revision: 1 },
    { id: 'var_3', name: 'Failure', revision: 2 },
  ],
};

const fallbackImpact: VariantDeletionImpact = {
  ...referencedImpact,
  affectedStates: [],
};

describe('VariantDeleteDialog', () => {
  it('requires a replacement candidate for an unreferenced fallback', async () => {
    const onConfirm = vi.fn();
    render(
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={fallbackImpact}
        loading={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('This Variant is the fallback response.')).toBeVisible();
    const confirm = screen.getByRole('button', { name: 'Delete Variant' });
    expect(confirm).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Replacement Variant'), 'var_3');
    await userEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith({ replacementVariantId: 'var_3' });
  });

  it('lists references and blocks deletion without offering a replacement', () => {
    render(
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={referencedImpact}
        loading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/Remove the App State bindings/)).toBeVisible();
    expect(screen.getByText('Signed out')).toBeVisible();
    expect(screen.getByText('Expired session')).toBeVisible();
    expect(screen.queryByLabelText('Replacement Variant')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
  });

  it('omits replacement selection when none is required and disables both actions while loading', () => {
    render(
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={{ ...referencedImpact, isFallback: false, affectedStates: [], replacementVariants: [] }}
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Replacement Variant')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('resets a stale replacement selection when deletion impact changes', async () => {
    const view = render(
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={fallbackImpact}
        loading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Replacement Variant'), 'var_3');

    view.rerender(
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={{
          ...fallbackImpact,
          endpointRevision: 8,
          replacementVariants: [{ id: 'var_1', name: 'Allowed', revision: 1 }],
        }}
        loading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Replacement Variant')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Delete Variant' })).toBeDisabled();
  });

  it('owns focus and background interaction, then restores its connected opener', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const view = render(
      <>
        <button type="button">Open Variant deletion</button>
        <VariantDeleteDialog
          isOpen={false}
          variant={variant}
          impact={fallbackImpact}
          loading={false}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open Variant deletion' });
    opener.focus();
    view.rerender(
      <>
        <button type="button">Open Variant deletion</button>
        <VariantDeleteDialog
          isOpen
          variant={variant}
          impact={fallbackImpact}
          loading={false}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete Denied' });
    expect(opener).toHaveAttribute('inert');
    expect(screen.getByLabelText('Replacement Variant')).toHaveFocus();
    for (let index = 0; index < 4; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    }
    fireEvent.click(view.container.querySelector('.bg-black')!);
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(
      <>
        <button type="button">Open Variant deletion</button>
        <VariantDeleteDialog
          isOpen={false}
          variant={variant}
          impact={fallbackImpact}
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
      <VariantDeleteDialog
        isOpen
        variant={variant}
        impact={referencedImpact}
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete Denied' });

    expect(dialog).toHaveFocus();
    await user.tab();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(container.querySelector('.bg-black')!);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
