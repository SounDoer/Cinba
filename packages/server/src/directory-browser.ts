// Reads the local directory tree in the small shape understood by Cinba clients.

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerMessage } from "@cinba/contract";

export type DirectoryListing = Extract<ServerMessage, { type: "dir_listing" }>;

export function listDirectories(path: string): DirectoryListing {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(path, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith("."))
      .map((item) => item.name)
      .toSorted();
  } catch {
    // Missing, unreadable, and non-directory paths all appear as an empty listing.
  }

  const parent = dirname(path);
  return {
    type: "dir_listing",
    path,
    parent: parent === path ? null : parent,
    dirs,
  };
}
