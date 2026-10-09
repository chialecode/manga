import { useEffect, useState } from "react";
import { attempt } from "../lib/api.ts";

/** A screenshot's small picture: the handle is asked for when the picture comes into the list, and a missing file leaves a blank. */
export function ScreenshotThumb(props: { screenshotId: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    void attempt<{ url: string }>("screenshot.image", { screenshotId: props.screenshotId }).then((result) => { if (live && result.ok) setUrl(result.value.url); });
    return () => { live = false; };
  }, [props.screenshotId]);
  const className = props.className ?? "folder-thumb";
  return url ? <img className={className} src={url} alt={props.alt} loading="lazy" /> : <span className={`${className} folder-thumb-empty`} aria-hidden="true" />;
}
