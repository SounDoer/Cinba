import { test } from "node:test";
import assert from "node:assert/strict";
import { currentReleaseRevision, releasePath, releasesToRemove } from "./release-layout.ts";

const CURRENT = "1234567890abcdef1234567890abcdef12345678";
const PREVIOUS = "abcdef1234567890abcdef1234567890abcdef12";
const OLD = "fedcba0987654321fedcba0987654321fedcba09";
const ROOT = "/home/cinba/releases";

test("a release path is one validated direct child of its root", () => {
  assert.equal(releasePath(ROOT, CURRENT.toUpperCase()), `${ROOT}/${CURRENT}`);
  assert.throws(() => releasePath(ROOT, "../../etc"), /not a full Git revision/);
  assert.throws(() => releasePath("releases", CURRENT), /must be an absolute POSIX path/);
  assert.throws(() => releasePath("/", CURRENT), /cannot be used as the releases root/);
});

test("current may be a relative symlink to one release", () => {
  assert.equal(
    currentReleaseRevision({
      releasesRoot: ROOT,
      currentLink: "/home/cinba/current",
      linkTarget: `releases/${CURRENT}`,
    }),
    CURRENT,
  );
});

test("current fails closed when it escapes or points below a release", () => {
  assert.throws(
    () =>
      currentReleaseRevision({
        releasesRoot: ROOT,
        currentLink: "/home/cinba/current",
        linkTarget: "/etc",
      }),
    /outside the releases root/,
  );
  assert.throws(
    () =>
      currentReleaseRevision({
        releasesRoot: ROOT,
        currentLink: "/home/cinba/current",
        linkTarget: `releases/${CURRENT}/nested`,
      }),
    /outside the releases root/,
  );
});

test("cleanup keeps protected releases and ignores every suspicious entry", () => {
  assert.deepEqual(
    releasesToRemove({
      releasesRoot: ROOT,
      entries: [
        { name: CURRENT, isDirectory: true },
        { name: PREVIOUS, isDirectory: true },
        { name: OLD.toUpperCase(), isDirectory: true },
        { name: "../../etc", isDirectory: true },
        { name: "notes", isDirectory: true },
        { name: "0000000000000000000000000000000000000000", isDirectory: false },
      ],
      protectedRevisions: [CURRENT, PREVIOUS],
    }),
    [`${ROOT}/${OLD}`],
  );
});

test("an invalid protected revision stops cleanup rather than weakening protection", () => {
  assert.throws(
    () =>
      releasesToRemove({
        releasesRoot: ROOT,
        entries: [{ name: OLD, isDirectory: true }],
        protectedRevisions: ["unknown"],
      }),
    /not a full Git revision/,
  );
});
