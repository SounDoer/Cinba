// JSONL 切行。
//
// 为什么不用 readline：
// 1. 流给的是「一坨字节」不是「一行」，一次 data 可能是半行或三行半，必须自己攒。
// 2. Pi 文档明确要求只按 \n 切分。readline 这类通用读取器会把 Unicode
//    行分隔符也当换行，而模型输出里可能带这些字符，一旦误切 JSON 就断了。

/**
 * 造一个切行器。返回的函数每收到一块文本就调用一次，
 * 攒够完整的行（以 \n 结尾）就通过 onLine 吐出去。
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
