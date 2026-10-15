import { Link2 } from "lucide-react";

/**
 * "Match with Bangumi" in a reader's title area, shown only while the work is not linked to an entry. It opens the same dialog as the
 * work's own page; nothing is written until the user confirms the preview there.
 */
export function MatchLink(props: { label: string; onMatch?: () => void }) {
  if (!props.onMatch) return null;
  return <button type="button" className="link-button reader-match" data-testid="reader-match" onClick={props.onMatch}><Link2 size={13} />{props.label}</button>;
}
