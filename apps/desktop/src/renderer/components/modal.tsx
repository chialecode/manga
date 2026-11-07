import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

/**
 * A modal or side drawer on Radix Dialog: focus is trapped and restored, Escape closes, and the page behind is inert.
 * An input method that is still composing keeps its Escape (it cancels the composition, not the dialog).
 */
export function Modal(props: {
  title: string;
  description?: string;
  closeLabel: string;
  onClose: () => void;
  testId: string;
  /** `drawer` slides in from the right edge; `dialog` is centered. */
  variant?: "dialog" | "drawer";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const drawer = props.variant === "drawer";
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={drawer ? "modal-content modal-drawer" : "modal-content modal-dialog"}
          data-testid={props.testId}
          onEscapeKeyDown={(event) => { if ((event as KeyboardEvent).isComposing) event.preventDefault(); }}
        >
          <header className="modal-head">
            <Dialog.Title className="modal-title">{props.title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={props.closeLabel} data-testid={`${props.testId}-close`}><X size={18} /></Dialog.Close>
          </header>
          {props.description ? <Dialog.Description className="modal-description">{props.description}</Dialog.Description> : <Dialog.Description className="sr-only">{props.title}</Dialog.Description>}
          <div className="modal-body">{props.children}</div>
          {props.footer ? <footer className="modal-foot">{props.footer}</footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
