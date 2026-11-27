import { z } from "zod";

/**
 * The file a declarative provider plugin carries (PLUG-07, 计划 4.1): where a service is, what models and services it offers, and how the host talks to
 * each. The plugin runs no code: every request is made by MANGA itself through one of the host's own adapters, only to the hosts the file declares, with
 * the key kept in the main process. A file that names an adapter the host does not have, an address that is not https, or a host it does not declare is
 * refused when the package is inspected.
 */
export const PROVIDER_FORMAT = "manga-provider-v1";
export const PROVIDER_FILE_MAX_BYTES = 64 * 1024;

/** The adapters the host implements; a provider can only name these. `openai-chat-completions` takes a dialect (only `deepseek` so far). */
export const PROVIDER_ADAPTERS = [
  "openai-chat-completions",
  "deepseek-asr@1",
  "deepseek-tts@1",
  "deepseek-search@1",
  "deepseek-fetch@1",
  "deepseek-ocr@1",
] as const;
export type ProviderAdapter = (typeof PROVIDER_ADAPTERS)[number];

/** The service kinds a provider can offer besides chat models, and the adapters that serve each. */
export const PROVIDER_SERVICE_ADAPTERS = {
  transcription: ["deepseek-asr@1"],
  speech: ["deepseek-tts@1"],
  search: ["deepseek-search@1"],
  fetch: ["deepseek-fetch@1"],
  ocr: ["deepseek-ocr@1"],
} as const;
export const PROVIDER_SERVICE_KINDS = ["transcription", "speech", "search", "fetch", "ocr"] as const;
export type ProviderServiceKind = keyof typeof PROVIDER_SERVICE_ADAPTERS;

/** Service wire interface names implemented by the host protocol layer. */
export const PROVIDER_SERVICE_INTERFACES = [
  "deepseek_asr",
  "deepseek_tts",
  "deepseek_search",
  "deepseek_fetch",
  "deepseek_ocr",
] as const;
export type ProviderServiceInterface = (typeof PROVIDER_SERVICE_INTERFACES)[number];

/** Account-level capabilities a provider exposes under its declared host allowlist. */
export const PROVIDER_ACCOUNT_CAPABILITIES = ["balance", "files"] as const;
export type ProviderAccountCapability = (typeof PROVIDER_ACCOUNT_CAPABILITIES)[number];

/** Voices offered for read-aloud speech synthesis. */
export const SPEECH_VOICES = ["stella", "tide"] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number];

export const PROVIDER_DIALECTS = ["deepseek"] as const;
export type ProviderDialect = (typeof PROVIDER_DIALECTS)[number];

const LOCAL_HOST_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/i;
const slug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const host = z.string().min(3).max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host is a lower-case domain name")
  .refine((value) => !LOCAL_HOST_SUFFIX.test(value), "a host must not be a local or internal domain");
const httpsUrl = z.string().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "an address must be https without credentials");

/** A price in US dollars per unit; `per` is how many units the price is for (1,000,000 tokens, 10,000 characters, 3,600 seconds, 1,000 searches). */
const PriceSchema = z.object({ usd: z.number().nonnegative().max(1_000_000), per: z.number().int().positive().max(1_000_000_000) }).strict();
export type ProviderPrice = z.infer<typeof PriceSchema>;

export const ProviderModelSchema = z.object({
  id: text(128),
  name: text(80),
  description: z.string().max(300).default(""),
  adapter: z.literal("openai-chat-completions"),
  contextWindow: z.number().int().min(4_096).max(10_000_000),
  maxOutput: z.number().int().min(256).max(1_000_000),
  inputTypes: z.array(z.enum(["text", "image", "video", "pdf", "audio"])).min(1).max(5),
  capabilities: z.array(z.enum(["tools", "structured_output", "web_search", "reasoning"])).max(4),
  /** The reasoning levels the model takes, the one it uses by default, and whether thinking can be turned off. Left out for a model that does not reason. */
  reasoning: z.object({ levels: z.array(z.enum(["minimal", "low", "medium", "high", "max"])).min(1).max(5), default: z.enum(["minimal", "low", "medium", "high", "max"]), canDisable: z.boolean() }).strict().optional(),
  /** Selected by default in the add dialog (Q-41 第 3 项). */
  suggested: z.boolean().default(false),
  price: z.object({ input: PriceSchema, cachedInput: PriceSchema.optional(), output: PriceSchema }).strict().optional(),
}).strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderServiceSchema = z.object({
  kind: z.enum(PROVIDER_SERVICE_KINDS),
  adapter: z.enum(["deepseek-asr@1", "deepseek-tts@1", "deepseek-search@1", "deepseek-fetch@1", "deepseek-ocr@1"]),
  name: text(80),
  description: z.string().max(300).default(""),
  /** The service's own limits, for the host to keep under. */
  limits: z.object({
    uploadBytes: z.number().int().positive().optional(),
    seconds: z.number().int().positive().optional(),
    billedChars: z.number().int().positive().optional(),
    requestBytes: z.number().int().positive().optional(),
    queryChars: z.number().int().positive().optional(),
    results: z.number().int().positive().optional(),
    urlChars: z.number().int().positive().optional(),
    pages: z.number().int().positive().optional(),
  }).strict().default({}),
  /** For speech: the voices, the first being the default. */
  voices: z.array(z.object({ id: slug, name: text(40) }).strict()).max(16).optional(),
  suggested: z.boolean().default(true),
  /** Unit of the price: seconds of audio, billed characters, successful searches, page fetches, or OCR pages. */
  price: PriceSchema.extend({ unit: z.enum(["second", "char", "search", "fetch", "page"]) }).strict().optional(),
}).strict();
export type ProviderService = z.infer<typeof ProviderServiceSchema>;

export const ProviderFileSchema = z.object({
  format: z.literal(PROVIDER_FORMAT),
  id: slug,
  name: text(80),
  baseUrl: httpsUrl,
  hosts: z.array(host).min(1).max(8),
  /** Where a person gets a key. */
  keyUrl: httpsUrl.optional(),
  /** How the host lists the models of an account. */
  discovery: z.enum(["openai-models"]).optional(),
  dialect: z.enum(PROVIDER_DIALECTS).optional(),
  /** Account-level capabilities exposed under the declared host allowlist (e.g. balance query, Files API). */
  accountCapabilities: z.array(z.enum(PROVIDER_ACCOUNT_CAPABILITIES)).max(PROVIDER_ACCOUNT_CAPABILITIES.length).optional(),
  models: z.array(ProviderModelSchema).max(32),
  services: z.array(ProviderServiceSchema).max(8),
  /** When the prices were read off the provider's page (YYYY-MM-DD); estimates say so. */
  pricesCheckedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** A note on how the prices are used in estimates (peak, discounts). */
  priceNote: z.string().max(300).optional(),
}).strict().superRefine((file, ctx) => {
  let baseHost = "";
  try { baseHost = new URL(file.baseUrl).hostname; } catch { /* the url check reports it */ }
  if (baseHost && !file.hosts.includes(baseHost)) ctx.addIssue({ code: "custom", message: "the address's host is not one the provider declares", path: ["baseUrl"] });
  const ids = file.models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "a model is listed twice", path: ["models"] });
  for (const [index, service] of file.services.entries()) {
    if (!(PROVIDER_SERVICE_ADAPTERS[service.kind] as readonly string[]).includes(service.adapter)) ctx.addIssue({ code: "custom", message: "the adapter does not serve that kind of service", path: ["services", index, "adapter"] });
  }
  const kinds = file.services.map((service) => service.kind);
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: "custom", message: "a service kind is listed twice", path: ["services"] });
  for (const [index, model] of file.models.entries()) {
    if (model.maxOutput >= model.contextWindow) ctx.addIssue({ code: "custom", message: "the answer cannot be as long as the window", path: ["models", index, "maxOutput"] });
    if (model.reasoning && !model.reasoning.levels.includes(model.reasoning.default)) ctx.addIssue({ code: "custom", message: "the default reasoning level is not one of the levels", path: ["models", index, "reasoning"] });
  }
});
export type ProviderFile = z.infer<typeof ProviderFileSchema>;

/** One currency entry returned by a provider account balance query (e.g. DeepSeek `GET /user/balance`). */
export const ProviderBalanceInfoSchema = z.object({
  currency: z.string().min(1).max(16),
  totalBalance: z.string(),
  grantedBalance: z.string().optional(),
  toppedUpBalance: z.string().optional(),
}).strict();
export type ProviderBalanceInfo = z.infer<typeof ProviderBalanceInfoSchema>;

/** Account balance / availability snapshot returned by `providers.balance`. */
export const ProviderBalanceSchema = z.object({
  accountId: z.string().min(1),
  providerRef: z.string().min(1),
  available: z.boolean(),
  checkedAt: z.string().min(1),
  balances: z.array(ProviderBalanceInfoSchema),
  error: z.string().optional(),
}).strict();
export type ProviderBalance = z.infer<typeof ProviderBalanceSchema>;

/** OCR recognition modes supported by `deepseek-ocr@1`. */
export const OCR_PURPOSES = ["text_recognition", "rich_layout_recognition"] as const;
export type OcrPurpose = (typeof OCR_PURPOSES)[number];

export const OcrPageSchema = z.object({
  page: z.number().int().min(1),
  text: z.string(),
}).strict();
export type OcrPage = z.infer<typeof OcrPageSchema>;

/** Paged text and usage returned by `ocr.recognize` / `deepseek-ocr@1`. */
export const OcrResultSchema = z.object({
  text: z.string(),
  pages: z.array(OcrPageSchema),
  purpose: z.enum(OCR_PURPOSES),
  usage: z.object({
    pages: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export type OcrResult = z.infer<typeof OcrResultSchema>;

/** Web page fetch result returned by `deepseek-fetch@1` or local `webpage.fetch` extensions. */
export const WebFetchResultSchema = z.object({
  url: z.string().min(1),
  finalUrl: z.string().min(1).optional(),
  title: z.string(),
  content: z.string(),
  site: z.string().optional(),
  siteIcon: z.string().optional(),
  publishedAt: z.string().optional(),
  source: z.enum(["local", "deepseek_fetch"]).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

/** One web search result item returned by standalone search or built-in server search. */
export const WebSearchItemSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  site: z.string().optional(),
  siteIcon: z.string().optional(),
  publishedAt: z.string().optional(),
  snippet: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
}).strict();
export type WebSearchItem = z.infer<typeof WebSearchItemSchema>;

/** Upload purpose values accepted by DeepSeek Files API (`POST /v1/files`). */
export const FILE_UPLOAD_PURPOSES = ["user_data", "text_recognition", "rich_layout_recognition"] as const;
export type FileUploadPurpose = (typeof FILE_UPLOAD_PURPOSES)[number];

/** Reference to a file uploaded to a provider's Files API. */
export const ProviderFileRefSchema = z.object({
  fileId: z.string().min(1),
  filename: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  purpose: z.enum(FILE_UPLOAD_PURPOSES).optional(),
  mimeType: z.string().optional(),
  createdAt: z.string().optional(),
}).strict();
export type ProviderFileRef = z.infer<typeof ProviderFileRefSchema>;

/** Main-process single source of truth for active chat and provider capabilities (`providers.capabilities`). */
export const ProviderCapabilitiesSchema = z.object({
  hasAvailableTextModel: z.boolean(),
  webSearchAvailable: z.boolean(),
  nativeWebSearchAvailable: z.boolean(),
  standaloneWebSearchAvailable: z.boolean(),
  readUrlAvailable: z.boolean(),
  speechAvailable: z.boolean(),
  speechVoices: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
  streamingTtsAvailable: z.boolean(),
  fetchAvailable: z.boolean(),
  ocrAvailable: z.boolean(),
  filesAvailable: z.boolean(),
  balanceAvailable: z.boolean(),
  activeTextModelId: z.string().nullable(),
  activeTextDialect: z.enum(PROVIDER_DIALECTS).nullable(),
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/** Reads a provider file's bytes: the size, the JSON and the schema, with one sentence for why it is refused. */
export function parseProviderFile(bytes: Uint8Array): { ok: true; file: ProviderFile } | { ok: false; problem: string } {
  if (bytes.length > PROVIDER_FILE_MAX_BYTES) return { ok: false, problem: "the provider file is larger than 64 KiB" };
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return { ok: false, problem: "the provider file is not JSON" }; }
  const parsed = ProviderFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: `${issue?.path.join(".") || "file"}: ${issue?.message ?? "not valid"}`.slice(0, 300) };
  }
  return { ok: true, file: parsed.data };
}

/** The reference a connection keeps to its provider: `<plugin id>/<provider id>`. */
export const providerRef = (pluginId: string, providerId: string) => `${pluginId}/${providerId}`;
export function splitProviderRef(ref: string): { pluginId: string; providerId: string } | null {
  const at = ref.lastIndexOf("/");
  return at > 0 && at < ref.length - 1 ? { pluginId: ref.slice(0, at), providerId: ref.slice(at + 1) } : null;
}

/** The host that the deepseek dialect applies to even for a connection added by hand (as pi-ai detects it). */
export const DEEPSEEK_HOST = "api.deepseek.com";
