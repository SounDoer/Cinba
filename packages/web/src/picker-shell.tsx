// Shared accessible structure for modal pickers.

import type { ReactNode } from "react";

export function PickerShell({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="picker">
      <button
        className="picker-backdrop"
        type="button"
        aria-label={`Close ${label}`}
        onClick={onClose}
      />
      <dialog className="picker-box" open aria-modal="true" aria-label={label}>
        {children}
      </dialog>
    </div>
  );
}
