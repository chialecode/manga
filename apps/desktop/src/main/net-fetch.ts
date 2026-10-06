import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from "electron";

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" };

/** The parts of Electron's `net` this adapter uses; a test passes a fake. */
export type NetLike = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  request: (options: ClientRequestConstructorOptions) => ClientRequest;
};

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function headersOf(raw: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
  return headers;
}

/**
 * `fetch` for metadata sources, through Chromium's network stack so the system proxy and certificates apply.
 *
 * Electron's `net.fetch` rejects a `redirect: "manual"` request with "Redirect was cancelled" instead of answering with the
 * 3xx, so a client that checks every redirect target itself would see each redirect as an unreachable network. Such a request
 * goes through `net.request`, which reports the redirect; it is answered as a plain 3xx with its `Location`, and nothing is followed.
 */
export function createNetFetch(net: NetLike): (url: string, init?: FetchInit) => Promise<Response> {
  return (url, init = {}) => {
    if (init.redirect !== "manual") return net.fetch(url, init as RequestInit);
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) { reject(abortError(signal)); return; }
      const request = net.request({ url, method: init.method ?? "GET", redirect: "manual" });
      let settled = false;
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const onAbort = () => {
        request.abort();
        if (!settled) { settled = true; reject(abortError(signal!)); }
        else try { body?.error(abortError(signal!)); } catch { /* already closed */ }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      const answer = (response: Response) => { if (!settled) { settled = true; resolve(response); } };
      const fail = (error: unknown) => { done(); if (!settled) { settled = true; reject(error); } else try { body?.error(error); } catch { /* already closed */ } };

      for (const [name, value] of Object.entries(init.headers ?? {})) request.setHeader(name, value);
      request.on("redirect", (statusCode, _method, redirectUrl) => {
        request.abort();
        done();
        answer(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
      });
      request.on("response", (response) => {
        const status = response.statusCode;
        if (NULL_BODY.has(status)) {
          done();
          answer(new Response(null, { status, statusText: response.statusMessage, headers: headersOf(response.headers) }));
          return;
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            response.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            response.on("end", () => { done(); try { controller.close(); } catch { /* already errored */ } });
            response.on("error", (error: Error) => fail(error));
            response.on("aborted", () => fail(new Error("the response was aborted")));
          },
          cancel() { done(); request.abort(); },
        });
        answer(new Response(stream, { status, statusText: response.statusMessage, headers: headersOf(response.headers) }));
      });
      request.on("error", (error: Error) => fail(error));
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };
}
