import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Modal } from './Modal';

const modalClassName = 'relative bg-white p-4';

function NestedModals({ innerLoading = false }: { innerLoading?: boolean }) {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOuterOpen(true)}>Open outer</button>
      <Modal
        isOpen={outerOpen}
        label="Outer modal"
        className={modalClassName}
        onCancel={() => setOuterOpen(false)}
      >
        <button type="button" data-modal-initial-focus onClick={() => setInnerOpen(true)}>Open inner</button>
        <Modal
          isOpen={innerOpen}
          label="Inner modal"
          loading={innerLoading}
          className={modalClassName}
          onCancel={() => setInnerOpen(false)}
        >
          <button type="button" data-modal-initial-focus disabled={innerLoading}>Inner first</button>
          <button type="button" disabled={innerLoading}>Inner second</button>
        </Modal>
      </Modal>
    </>
  );
}

describe('Modal stack ownership', () => {
  it('layers dialog content above the fixed backdrop', () => {
    render(
      <Modal isOpen label="Layered modal" className="bg-white" onCancel={vi.fn()}>
        Visible content
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'Layered modal' }).parentElement).toHaveClass(
      'relative',
      'z-10',
    );
  });

  it('does not move focus when loading changes', () => {
    const view = render(
      <Modal isOpen label="Loading modal" loading={false} className={modalClassName} onCancel={vi.fn()}>
        <button type="button">First action</button>
        <button type="button">Current action</button>
      </Modal>,
    );
    const current = screen.getByRole('button', { name: 'Current action' });
    current.focus();

    view.rerender(
      <Modal isOpen label="Loading modal" loading className={modalClassName} onCancel={vi.fn()}>
        <button type="button">First action</button>
        <button type="button">Current action</button>
      </Modal>,
    );

    expect(current).toHaveFocus();
  });

  it('keeps Escape with the top modal and restores openers in stack order', async () => {
    const user = userEvent.setup();
    render(<NestedModals />);
    const outerOpener = screen.getByRole('button', { name: 'Open outer' });
    await user.click(outerOpener);
    const innerOpener = screen.getByRole('button', { name: 'Open inner' });
    await user.click(innerOpener);

    expect(screen.getByRole('button', { name: 'Inner first' })).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Inner modal' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Outer modal' })).toBeVisible();
    expect(innerOpener).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Outer modal' })).not.toBeInTheDocument();
    expect(outerOpener).toHaveFocus();
  });

  it('does not let Escape dismiss the outer owner while the inner owner is loading', async () => {
    const user = userEvent.setup();
    render(<NestedModals innerLoading />);
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    const inner = screen.getByRole('dialog', { name: 'Inner modal' });

    fireEvent.keyDown(inner, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Inner modal' })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Outer modal' })).toBeVisible();
  });

  it('keeps Tab arbitration inside only the top modal', async () => {
    const user = userEvent.setup();
    render(<NestedModals />);
    await user.click(screen.getByRole('button', { name: 'Open outer' }));
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    const first = screen.getByRole('button', { name: 'Inner first' });
    const second = screen.getByRole('button', { name: 'Inner second' });
    first.focus();

    fireEvent.keyDown(first, { key: 'Tab' });

    expect(second).toHaveFocus();
  });

  it('retains shared inert ownership until the last overlapping modal closes', () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const view = render(
      <>
        <button type="button">Background action</button>
        <Modal isOpen label="First modal" className={modalClassName} onCancel={firstCancel}>
          <button type="button">First action</button>
        </Modal>
        <Modal isOpen label="Second modal" className={modalClassName} onCancel={secondCancel}>
          <button type="button">Second action</button>
        </Modal>
      </>,
    );
    const background = screen.getByRole('button', { name: 'Background action' });
    expect(background).toHaveAttribute('inert');

    view.rerender(
      <>
        <button type="button">Background action</button>
        <Modal isOpen={false} label="First modal" className={modalClassName} onCancel={firstCancel}>
          <button type="button">First action</button>
        </Modal>
        <Modal isOpen label="Second modal" className={modalClassName} onCancel={secondCancel}>
          <button type="button">Second action</button>
        </Modal>
      </>,
    );
    expect(background).toHaveAttribute('inert');

    view.rerender(
      <>
        <button type="button">Background action</button>
        <Modal isOpen={false} label="First modal" className={modalClassName} onCancel={firstCancel}>
          <button type="button">First action</button>
        </Modal>
        <Modal isOpen={false} label="Second modal" className={modalClassName} onCancel={secondCancel}>
          <button type="button">Second action</button>
        </Modal>
      </>,
    );
    expect(background).not.toHaveAttribute('inert');
  });
});
