// Splitting JSONL into lines.
//
// Why not readline:
// 1. A stream hands us bytes, not lines. A single data event may carry half a
//    line or three and a half, so we have to buffer.
// 2. Pi's docs require splitting on \n only. General-purpose readers also treat
//    Unicode line separators as newlines, and model output can contain those.
//    One bad split tears the JSON apart.

/**
 * Make a line splitter. Call the returned function with each chunk of text;
 * once a complete line (ending in \n) has accumulated it goes out via onLine.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
): (chunk: string) => void {
  let buffer = "";

  return (chunk: string): void => {
    buffer += chunk;

    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}
