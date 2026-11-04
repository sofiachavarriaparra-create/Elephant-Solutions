#!/usr/bin/env node
// Convierte n8n/workflows/*.json al formato del Workflow SDK de n8n (n8n/sdk/*.js), que usa el
// servidor MCP oficial de n8n para crear workflows. El preludio común (núcleo + configuración) se
// declara una sola vez y se concatena en cada nodo Code: el resultado es idéntico al JSON.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'n8n', 'workflows'), OUT = join(ROOT, 'n8n', 'sdk');
mkdirSync(OUT, { recursive: true });
const MARK = '// ===== Lógica del nodo =====\n';
const TRIGGERS = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger']);

for (const f of readdirSync(IN).filter((x) => x.endsWith('.json')).sort()) {
  const j = JSON.parse(readFileSync(join(IN, f), 'utf8'));
  let prelude = null;
  const vars = new Map();
  const decl = j.nodes.map((n, i) => {
    const v = `n${i}`; vars.set(n.name, v);
    const params = structuredClone(n.parameters);
    let codeExpr = null;
    if (n.type === 'n8n-nodes-base.code' && params.jsCode.includes(MARK)) {
      const k = params.jsCode.indexOf(MARK) + MARK.length;
      const pre = params.jsCode.slice(0, k);
      if (prelude && prelude !== pre) throw new Error(`${f}: preludios distintos`);
      prelude = pre;
      codeExpr = `PRELUDE + ${JSON.stringify(params.jsCode.slice(k))}`;
      params.jsCode = '__CODE__';
    }
    const config = { name: n.name, parameters: params, position: n.position };
    for (const k of ['executeOnce', 'alwaysOutputData', 'onError', 'disabled', 'notes']) if (n[k] !== undefined) config[k] = n[k];
    let cfgTxt = JSON.stringify(config);
    if (codeExpr) cfgTxt = cfgTxt.replace('"__CODE__"', codeExpr);
    if (n.credentials) {
      const creds = Object.entries(n.credentials).map(([type, c]) => `${JSON.stringify(type)}: newCredential(${JSON.stringify(c.name)})`).join(', ');
      cfgTxt = cfgTxt.replace(/}$/, `, "credentials": { ${creds} } }`);
    }
    return `const ${v} = ${TRIGGERS.has(n.type) ? 'trigger' : 'node'}({ type: ${JSON.stringify(n.type)}, version: ${n.typeVersion}, config: ${cfgTxt} });`;
  });
  const edges = [];
  for (const [src, c] of Object.entries(j.connections)) {
    c.main.forEach((outs, oi) => outs.forEach((t) => edges.push(`  .add(${vars.get(src)}.output(${oi}).to(${vars.get(t.node)}.input(${t.index})))`)));
  }
  const code = `import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';
// Generado por scripts/build-sdk.mjs a partir de n8n/workflows/${f}. No editar a mano.
${prelude ? `const PRELUDE = ${JSON.stringify(prelude)};\n` : ''}${decl.join('\n')}
export default workflow(${JSON.stringify(f.replace('.json', ''))}, ${JSON.stringify(j.name)})
${j.nodes.map((n) => `  .add(${vars.get(n.name)})`).join('\n')}
${edges.join('\n')};
`;
  writeFileSync(join(OUT, f.replace('.json', '.js')), code);
  console.log(`✓ sdk/${f.replace('.json', '.js')}  ${code.length} caracteres, ${j.nodes.length} nodos, ${edges.length} conexiones`);
}
