import { createContext, useContext } from "react";
import { resolveKeys } from "@manga/contracts/keys";

/** The keys the readers and the window answer to now: the table's defaults, with what the person changed in the settings laid over them. */
export type KeyTable = Record<string, readonly string[]>;

export const DEFAULT_KEY_TABLE: KeyTable = resolveKeys(null);

const Context = createContext<KeyTable>(DEFAULT_KEY_TABLE);
export const KeyTableProvider = Context.Provider;
export const useKeyTable = (): KeyTable => useContext(Context);
