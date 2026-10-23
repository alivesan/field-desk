import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A bottom sheet on phones, a centred panel on desktop — a native modal <dialog> like the
 * confirm dialog in ui.tsx (so askConfirm opens on top of it). Its content is mounted only while
 * it is open, so every opening starts with fresh drafts. Esc, the backdrop and × close it.
 */
export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <div className="sheet-body">
          <span className="sheet-grab" aria-hidden />
          <button type="button" className="sheet-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
          {children}
        </div>
      )}
    </dialog>
  );
}
