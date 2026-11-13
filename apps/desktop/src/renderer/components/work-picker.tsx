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
  const [knownTitles, setKnownTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void attempt<{ items: Option[] }>("works.list", { sort: "title", limit: 200, ...(query.trim() ? { query: query.trim() } : {}) }).then((result) => {
        if (!live || !result.ok) return;
        const list = asArray<Option>(result.value.items);
        setOptions(list);
        if (list.length > 0) {
          setKnownTitles((current) => {
            const next = { ...current };
            for (const item of list) next[item.id] = item.title;
            return next;
          });
        }
      });
    }, query ? 200 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query]);

  const value = props.value;
  const knownOption = options.find((option) => option.id === value);
  const cachedTitle = value ? (knownOption?.title ?? knownTitles[value]) : undefined;

  // When a selected work is outside the current page or filtered out, resolve its human title without ever rendering the raw ID.
  useEffect(() => {
    if (!value || cachedTitle) return;
    let live = true;
    void attempt<{ title?: string; work?: { title?: string } }>("works.get", { workId: value }).then((result) => {
      if (!live || !result.ok) return;
      const title = result.value.work?.title ?? result.value.title;
      if (title) setKnownTitles((current) => ({ ...current, [value]: title }));
    });
    return () => { live = false; };
  }, [value, cachedTitle]);

  return (
    <div className="work-picker" data-testid={props.testId}>
      <input type="search" aria-label={props.label} placeholder={props.placeholder} data-testid={`${props.testId}-query`} value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label={props.label} data-testid={`${props.testId}-select`} value={value ?? ""} onChange={(event) => props.onChange(event.target.value || null)}>
        <option value="">{props.placeholder}</option>
        {!knownOption && value ? <option value={value}>{cachedTitle || props.placeholder}</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
      </select>
    </div>
  );
}
