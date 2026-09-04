import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

interface InertOwnership {
  count: number;
  originallyInert: boolean;
}

interface ModalOwner {
  overlay: HTMLElement;
  opener: HTMLElement | null;
  active: boolean;
}

const inertOwnership = new WeakMap<HTMLElement, InertOwnership>();
const modalOwners: ModalOwner[] = [];
let stackOwnedInert = new Set<HTMLElement>();

function acquireInert(element: HTMLElement) {
  const ownership = inertOwnership.get(element);
  if (ownership) {
    ownership.count += 1;
    return;
  }
  inertOwnership.set(element, {
    count: 1,
    originallyInert: element.hasAttribute('inert'),
  });
  element.setAttribute('inert', '');
}

function releaseInert(element: HTMLElement) {
  const ownership = inertOwnership.get(element);
  if (!ownership) return;
  ownership.count -= 1;
  if (ownership.count > 0) return;
  inertOwnership.delete(element);
  if (!ownership.originallyInert) element.removeAttribute('inert');
}

function topModalOwner() {
  for (let index = modalOwners.length - 1; index >= 0; index -= 1) {
    if (modalOwners[index]?.active) return modalOwners[index];
  }
  return undefined;
}

function syncStackInert() {
  const top = topModalOwner();
  const desired = new Set(modalOwners
    .filter(owner => owner.active
      && owner !== top
      && top !== undefined
      && !owner.overlay.contains(top.overlay))
    .map(owner => owner.overlay));
  for (const element of stackOwnedInert) {
    if (!desired.has(element)) releaseInert(element);
  }
  for (const element of desired) {
    if (!stackOwnedInert.has(element)) acquireInert(element);
  }
  stackOwnedInert = desired;
}

function restoreClosedOpeners() {
  while (modalOwners.at(-1)?.active === false) {
    const owner = modalOwners.pop();
    if (owner?.opener?.isConnected) owner.opener.focus();
  }
}

const focusableSelector = [
  '[data-modal-initial-focus]:not(:disabled)',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  isOpen: boolean;
  label: string;
  loading?: boolean;
  className: string;
  children: ReactNode;
  onCancel(): void;
}

export function Modal({
  isOpen,
  label,
  loading = false,
  className,
  children,
  onCancel,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<ModalOwner | undefined>(undefined);

  useEffect(() => {
    if (!isOpen || !overlayRef.current) return;

    const owner: ModalOwner = {
      overlay: overlayRef.current,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      active: true,
    };
    ownerRef.current = owner;
    modalOwners.push(owner);
    const background = new Set<HTMLElement>();
    let modalBranch: HTMLElement = overlayRef.current;
    while (modalBranch.parentElement && modalBranch.parentElement !== document.body) {
      for (const element of modalBranch.parentElement.children) {
        if (element instanceof HTMLElement
          && element !== modalBranch
          && !element.hasAttribute('data-modal-overlay')) {
          background.add(element);
          acquireInert(element);
        }
      }
      modalBranch = modalBranch.parentElement;
    }
    syncStackInert();

    return () => {
      background.forEach(releaseInert);
      owner.active = false;
      syncStackInert();
      restoreClosedOpeners();
      ownerRef.current = undefined;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    if (topModalOwner() !== ownerRef.current) return;
    const initialFocus = dialogRef.current.querySelector<HTMLElement>(
      '[data-modal-initial-focus]:not(:disabled)',
    ) ?? dialogRef.current.querySelector<HTMLElement>(focusableSelector);
    (initialFocus ?? dialogRef.current).focus();
  }, [isOpen]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    if (topModalOwner() !== ownerRef.current) {
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!loading) onCancel();
      return;
    }
    if (!dialogRef.current) return;

    event.preventDefault();
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
    );
    if (focusable.length === 0) {
      dialogRef.current.focus();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    focusable[nextIndex]?.focus();
  };

  if (!isOpen) return null;

  return (
    <div ref={overlayRef} data-modal-overlay className="fixed inset-0 z-50 overflow-y-auto">
      <div
        data-modal-backdrop
        className="fixed inset-0 bg-black bg-opacity-50"
        onClick={loading ? undefined : onCancel}
      />
      <div className="relative z-10 flex min-h-full items-center justify-center p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className={className}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
