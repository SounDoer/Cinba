// 目录选择器。
//
// 浏览器拿不到本地路径（那是刻意的安全限制），所以由服务器列目录、这里只负责画。
// 桌面版与网页版共用这一套——3b-2 远程接入时同样成立。

import { useEffect, useState } from "react";
import type { RemoteSession } from "@cinba/core-client";

export type Listing = { path: string; parent: string | null; dirs: string[] };

/** 拼子目录路径。服务器返回什么分隔符就跟着用，免得混用两种斜杠。 */
function childPath(current: string, name: string): string {
  const separator = current.includes("\\") ? "\\" : "/";
  return current.endsWith(separator) ? `${current}${name}` : `${current}${separator}${name}`;
}

export function ProjectPicker({
  remote,
  listing,
  startPath,
  onClose,
}: {
  remote: RemoteSession | undefined;
  listing: Listing | undefined;
  startPath: string;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState(startPath);

  useEffect(() => {
    remote?.listDir(startPath);
  }, [remote, startPath]);

  function go(path: string) {
    setCurrent(path);
    remote?.listDir(path);
  }

  // 只在服务器返回的正是当前目录时才画，免得进目录的瞬间显示上一层的内容。
  const shown = listing?.path === current ? listing : undefined;

  return (
    <div className="picker" onClick={onClose}>
      <div className="picker-box" onClick={(event) => event.stopPropagation()}>
        <div className="picker-path">{current}</div>

        <div className="picker-list">
          {shown?.parent ? (
            <button className="picker-item" onClick={() => go(shown.parent!)}>
              .. 上一级
            </button>
          ) : null}
          {shown?.dirs.map((name) => (
            <button className="picker-item" key={name} onClick={() => go(childPath(current, name))}>
              {name}
            </button>
          ))}
          {shown && shown.dirs.length === 0 ? (
            <div className="picker-item">（没有子目录）</div>
          ) : null}
        </div>

        <div className="picker-actions">
          <button onClick={onClose}>取消</button>
          <button
            onClick={() => {
              remote?.setProject(current);
              onClose();
            }}
          >
            就用这个目录
          </button>
        </div>
      </div>
    </div>
  );
}
