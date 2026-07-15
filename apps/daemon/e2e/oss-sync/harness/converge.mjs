import assert from "node:assert/strict";

/** sidecar 文件名形如 <stem>.conflict.<ts>.<hash8>.<ext> */
export function isSidecar(relPath) {
  return /\.conflict\.\d+\.[0-9a-f]{8}\./.test(relPath);
}

/** tree: { relPath -> base64 内容 }，拆成 regular / sidecars */
export function splitTree(tree) {
  const regular = {};
  const sidecars = {};
  for (const [k, v] of Object.entries(tree)) {
    (isSidecar(k) ? sidecars : regular)[k] = v;
  }
  return { regular, sidecars };
}

/** 断言两节点的"正常文件"集合逐字节一致（忽略 sidecar） */
export function assertConverged(treeA, treeB, label = "") {
  const a = splitTree(treeA).regular;
  const b = splitTree(treeB).regular;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  assert.deepEqual(
    keysA,
    keysB,
    `${label} file sets differ\nA=${JSON.stringify(keysA)}\nB=${JSON.stringify(keysB)}`,
  );
  for (const k of keysA) {
    assert.equal(a[k], b[k], `${label} content differs for ${k}`);
  }
}
