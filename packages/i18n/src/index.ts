import { catalogs, defaultLocale, type Locale, type MessageKey } from "./messages.ts";

export { catalogs, defaultLocale, locales, type Locale, type MessageKey } from "./messages.ts";

export type Translator = {
  locale: Locale;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
  formatNumber(value: number): string;
  formatDate(value: string | Date): string;
};

export function createTranslator(locale: Locale = defaultLocale): Translator {
  const catalog = catalogs[locale] ?? catalogs[defaultLocale];
  const number = new Intl.NumberFormat(locale === "qps-ploc" ? "en-US" : locale);
  const date = new Intl.DateTimeFormat(locale === "qps-ploc" ? "en-US" : locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return {
    locale,
    t(key, vars = {}) {
      const template = catalog[key] ?? catalogs[defaultLocale][key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
    },
    formatNumber(value) {
      return number.format(value);
    },
    formatDate(value) {
      return date.format(typeof value === "string" ? new Date(value) : value);
    },
  };
}
