#!/usr/bin/env node
// Read literal JSON from a compiled archive without executing any archived code.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function extractBundle(text) {
  const source = ts.createSourceFile('archive.js', text, ts.ScriptTarget.Latest, true);
  const records = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'JSON.parse'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      try { records.push({ offset: node.pos, value: JSON.parse(node.arguments[0].text) }); } catch { /* Not literal JSON. */ }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const tours = records.filter(({ value }) => value?.payload?.objects?.some(point => point.sweep && typeof point.content === 'string'));
  if (tours.length !== 1) throw new Error(`Expected one authored tour, found ${tours.length}. Select a release bundle, not its SDK.`);
  return { schema: 'sphr-compiled-tour-source-v1', sha256: createHash('sha256').update(text).digest('hex'),
    points: tours[0].value.payload.objects, records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/legacy/extract-bundle.mjs <bundle.js> <source.json>');
  writeFileSync(output, JSON.stringify(extractBundle(readFileSync(input, 'utf8')), null, 2) + '\n');
}
