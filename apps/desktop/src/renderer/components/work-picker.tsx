import { useEffect, useState } from "react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";

type Option = { id: string; title: string; mediaKind: string };

/**
 * A work chosen from the library: a search box that narrows the list and the list itself. It asks for at most 200 works at a time, which is
 * all a person scrolls; the search is how a larger library is reached.
 */
export function WorkPicker(props: { t: Translator["t"]; value: string | null; onChange: (workId: string | null) => void; label: string; placeholder: string; testId: string }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void attempt<{ items: Option[] }>("works.list", { sort: "title", limit: 200, ...(query.trim() ? { query: query.trim() } : {}) }).then((result) => {
        if (live && result.ok) setOptions(asArray<Option>(result.value.items));
      });
    }, query ? 200 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);
  const known = options.some((option) => option.id === props.value);
  return (
    <div className="work-picker" data-testid={props.testId}>
      <input type="search" aria-label={props.label} placeholder={props.placeholder} data-testid={`${props.testId}-query`} value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label={props.label} data-testid={`${props.testId}-select`} value={props.value ?? ""} onChange={(event) => props.onChange(event.target.value || null)}>
        <option value="">{props.placeholder}</option>
        {!known && props.value ? <option value={props.value}>{props.value}</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
      </select>
    </div>
  );
}
