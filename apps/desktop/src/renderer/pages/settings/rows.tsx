import type { ReactNode } from "react";

/**
 * The settings layout (交互设计 3.5): a centered column, sections with a heading, and rows with the name and its explanation on
 * the left and the control on the right. Every page is built from these, so the pages look the same and narrow windows stack them.
 */
export function SettingsPage(props: { id: string; title: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`settings-page${props.wide ? " settings-page-wide" : ""}`} data-testid={`settings-page-${props.id}`} aria-labelledby={`settings-title-${props.id}`}>
      <header className="settings-page-head">
        <h2 id={`settings-title-${props.id}`}>{props.title}</h2>
        {props.hint ? <p className="detail-muted">{props.hint}</p> : null}
      </header>
      {props.children}
    </section>
  );
}

export function SettingsSection(props: { title?: string; hint?: string; testId?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" data-testid={props.testId}>
      {props.title || props.actions ? (
        <header className="settings-section-head">
          {props.title ? <h3>{props.title}</h3> : <span />}
          {props.actions ? <div className="settings-section-actions">{props.actions}</div> : null}
        </header>
      ) : null}
      {props.hint ? <p className="detail-muted settings-section-hint">{props.hint}</p> : null}
      <div className="settings-rows">{props.children}</div>
    </section>
  );
}

/** One setting: the label (a `<label>` when it names a control) with its explanation, and the control. */
export function SettingsRow(props: { label: string; hint?: string; htmlFor?: string; testId?: string; children?: ReactNode; stacked?: boolean }) {
  const name = props.htmlFor
    ? <label htmlFor={props.htmlFor} className="settings-row-name">{props.label}</label>
    : <span className="settings-row-name">{props.label}</span>;
  return (
    <div className={`settings-row${props.stacked ? " settings-row-stacked" : ""}`} data-testid={props.testId}>
      <div className="settings-row-text">
        {name}
        {props.hint ? <span className="settings-row-hint detail-muted">{props.hint}</span> : null}
      </div>
      {props.children ? <div className="settings-row-control">{props.children}</div> : null}
    </div>
  );
}

/** A page that has nothing to show yet or is turned off. */
export function SettingsEmpty(props: { text: string; testId?: string }) {
  return <p className="detail-muted settings-empty" role="status" data-testid={props.testId}>{props.text}</p>;
}

/** Previous / next for a paged list, with where in the list the reader is. */
export function Pager(props: { offset: number; limit: number; total: number; onPage: (offset: number) => void; label: (from: number, to: number, total: number) => string; previous: string; next: string; testId: string }) {
  const { offset, limit, total } = props;
  if (total <= limit) return total > 0 ? <p className="detail-muted settings-pager-label" data-testid={`${props.testId}-range`}>{props.label(1, total, total)}</p> : null;
  const from = offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <div className="settings-pager" data-testid={props.testId}>
      <button type="button" className="secondary-button" data-testid={`${props.testId}-prev`} disabled={offset <= 0} onClick={() => props.onPage(Math.max(0, offset - limit))}>{props.previous}</button>
      <span className="detail-muted" data-testid={`${props.testId}-range`}>{props.label(from, to, total)}</span>
      <button type="button" className="secondary-button" data-testid={`${props.testId}-next`} disabled={to >= total} onClick={() => props.onPage(offset + limit)}>{props.next}</button>
    </div>
  );
}
