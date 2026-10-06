import { X } from "lucide-react";

/**
 * Short notices (A-47): a result is told for a few seconds in the corner and goes away; an error stays until it is closed.
 * Nothing here sits above the page, so a notice never moves what the reader is looking at. The host owns the timer, so a
 * notice that is replaced restarts its time.
 */
export function Toasts(props: {
  notice?: string;
  error?: string;
  /** A problem that does not go away by itself (a restart is needed) and is not the result of an action. */
  sticky?: string;
  closeLabel: string;
  onCloseNotice: () => void;
  onCloseError: () => void;
}) {
  if (!props.notice && !props.error && !props.sticky) return null;
  return (
    <div className="toasts" data-testid="toasts">
      {props.error ? (
        <div role="alert" className="toast toast-danger" data-testid="toast-error">
          <span>{props.error}</span>
          <button type="button" className="icon-button" aria-label={props.closeLabel} data-testid="toast-error-close" onClick={props.onCloseError}><X size={14} /></button>
        </div>
      ) : null}
      {props.sticky ? <div role="status" className="toast toast-danger" data-testid="toast-sticky"><span>{props.sticky}</span></div> : null}
      {props.notice ? (
        <div role="status" className="toast" data-testid="toast-notice">
          <span>{props.notice}</span>
          <button type="button" className="icon-button" aria-label={props.closeLabel} data-testid="toast-notice-close" onClick={props.onCloseNotice}><X size={14} /></button>
        </div>
      ) : null}
    </div>
  );
}
