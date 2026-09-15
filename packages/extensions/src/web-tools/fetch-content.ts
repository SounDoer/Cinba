import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type SafeHttpResponse, fetchPublicUrl } from "./safe-http.ts";

export type WebFetchContent = {
  requestedUrl: string;
  finalUrl: string;
  title: string | undefined;
  contentType: string | undefined;
  content: string;
  downloadTruncated: boolean;
  outputTruncated: boolean;
};

export type WebFetchContentOptions = {
  fetchUrl?: (url: string, options?: { signal?: AbortSignal }) => Promise<SafeHttpResponse>;
  maxElements?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_ELEMENTS = 50_000;

function decodeBody(body: Uint8Array, contentType: string | undefined): string {
  const charset = contentType?.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch (error) {
    throw new Error(`web_fetch does not support charset: ${charset}`, { cause: error });
  }
}

export async function fetchWebContent(
  requestedUrl: string,
  options: WebFetchContentOptions = {},
): Promise<WebFetchContent> {
  const response = await (options.fetchUrl ?? fetchPublicUrl)(requestedUrl, {
    signal: options.signal,
  });
  const contentType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/plain") {
    const truncated = truncateHead(decodeBody(response.body, response.contentType), {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    return {
      requestedUrl,
      finalUrl: response.finalUrl,
      title: undefined,
      contentType: response.contentType,
      content: truncated.content,
      downloadTruncated: response.downloadTruncated,
      outputTruncated: truncated.truncated,
    };
  }
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw new Error(`web_fetch does not support content type: ${contentType ?? "unknown"}`);
  }

  const [{ Readability }, { JSDOM }, { default: TurndownService }] = await Promise.all([
    import("@mozilla/readability"),
    import("jsdom"),
    import("turndown"),
  ]);
  const dom = new JSDOM(decodeBody(response.body, response.contentType), {
    url: response.finalUrl,
  });
  try {
    const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
    if (dom.window.document.getElementsByTagName("*").length > maxElements) {
      throw new Error(`web_fetch page contains more than ${maxElements} elements`);
    }
    for (const element of dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      element.setAttribute("href", element.href);
    }
    for (const element of dom.window.document.querySelectorAll<HTMLImageElement>("img[src]")) {
      element.setAttribute("src", element.src);
    }
    for (const element of dom.window.document.querySelectorAll("nav, header, footer, aside")) {
      element.remove();
    }

    const turndown = new TurndownService({
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      headingStyle: "atx",
    });
    turndown.remove(["script", "style", "noscript"]);
    const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
    const markdown = turndown
      .turndown(article?.content || dom.window.document.body.innerHTML)
      .trim();
    if (markdown === "") {
      throw new Error("web_fetch could not extract readable content from the page");
    }
    const truncated = truncateHead(markdown, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });

    return {
      requestedUrl,
      finalUrl: response.finalUrl,
      title: article?.title || dom.window.document.title || undefined,
      contentType: response.contentType,
      content: truncated.content,
      downloadTruncated: response.downloadTruncated,
      outputTruncated: truncated.truncated,
    };
  } finally {
    dom.window.close();
  }
}
