import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('disables both actions while the mutation owns the dialog', () => {
    render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('can disable confirmation without disabling cancellation', () => {
    render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        confirmDisabled
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('keeps conflict feedback and its recovery action inside the owning dialog', async () => {
    const onRecovery = vi.fn();
    render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        recoveryMessage="Server revision 8"
        recoveryLabel="Refresh App State"
        onRecovery={onRecovery}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    expect(within(dialog).getByText('Server revision 8')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh App State' }));
    expect(onRecovery).toHaveBeenCalledOnce();
  });

  it('ignores backdrop cancellation while loading', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(container.querySelector('.bg-black')!);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels from the backdrop when not loading', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(container.querySelector('.bg-black')!);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['normal', false],
    ['loading with every action disabled', true],
  ] as const)('keeps focus inside the dialog in the %s state', async (_case, loading) => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Background action</button>
        <div>
          <div>
            <ConfirmDialog
              isOpen
              title="Delete App State"
              message="This cannot be undone."
              loading={loading}
              onConfirm={vi.fn()}
              onCancel={vi.fn()}
            />
          </div>
        </div>
      </>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete App State' });
    expect(screen.getByRole('button', { name: 'Background action' })).toHaveAttribute('inert');
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);

    for (let index = 0; index < 3; index += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    }
  });

  it('restores focus to the opener when the dialog closes', () => {
    const openerView = render(<button type="button">Delete state</button>);
    const opener = screen.getByRole('button', { name: 'Delete state' });
    opener.focus();
    const dialogView = render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    dialogView.rerender(
      <ConfirmDialog
        isOpen={false}
        title="Delete App State"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(opener).toHaveFocus();
    openerView.unmount();
  });

  it('does not restore focus when the opener is no longer connected', () => {
    const openerView = render(<button type="button">Delete state</button>);
    const opener = screen.getByRole('button', { name: 'Delete state' });
    opener.focus();
    const restoreFocus = vi.spyOn(opener, 'focus');
    const dialogView = render(
      <ConfirmDialog
        isOpen
        title="Delete App State"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    openerView.unmount();
    dialogView.unmount();

    expect(restoreFocus).not.toHaveBeenCalled();
  });
});
