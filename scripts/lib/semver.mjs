// Release-tag ordering for scripts/kestrel-delta.mjs: SemVer precedence on `vX.Y.Z` tags
// with optional pre-release identifiers (`v1.3.0-alpha.1`).

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Whether `tag` is a version tag this ordering understands. */
export function isVersionTag(tag) {
  return TAG.test(tag);
}

/** Negative, zero or positive as `a` precedes, equals or follows `b`. */
export function compareTags(a, b) {
  const x = TAG.exec(a);
  const y = TAG.exec(b);
  if (!x || !y) {
    throw new Error(`not a version tag: ${!x ? a : b}`);
  }
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) {
      return d;
    }
  }
  // A release follows its pre-releases; pre-releases compare field by field, numeric
  // fields numerically and before alphanumeric ones, and a longer list follows a prefix.
  if (!x[4] || !y[4]) {
    return (x[4] ? -1 : 0) - (y[4] ? -1 : 0);
  }
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) {
      return p[i] === undefined ? -1 : 1;
    }
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0) {
        return d;
      }
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p[i] !== q[i]) {
      return p[i] < q[i] ? -1 : 1;
    }
  }
  return 0;
}
