// Generate X.proxy.mjs for each built .jsw module, imitating Wix's web-method
// proxy: every exported function called from ANOTHER module returns a Promise
// (even sync ones); non-function exports pass through as live bindings.
import fs from 'node:fs';
const [dir, ...names] = process.argv.slice(2);
for (const name of names) {
  const src = fs.readFileSync(`${dir}/${name}.mjs`, 'utf8');
  const fns = [...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]);
  const consts = [...src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]);
  let out = `import * as m from './${name}.mjs';\n`;
  for (const f of fns) out += `export function ${f}(...a) { return Promise.resolve().then(() => m.${f}(...a)); }\n`;
  if (consts.length) out += `export { ${consts.join(', ')} } from './${name}.mjs';\n`;
  fs.writeFileSync(`${dir}/${name}.proxy.mjs`, out);
}
