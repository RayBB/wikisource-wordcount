#!/usr/bin/env node
import { count, formatResult, isError } from './core.js';

const USAGE = `Usage: node dist/cli.js [--json] <Wikisource URL or page title> [...]
  e.g. node dist/cli.js https://en.wikisource.org/wiki/The_Saturday_Evening_Post/Charcoal`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const targets = argv.filter((a) => a !== '--json');
  if (!targets.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return targets.length ? 0 : 1;
  }
  let failed = false;
  for (const t of targets) {
    try {
      const r = await count(t);
      if (isError(r)) failed = true;
      console.log(json ? JSON.stringify(r) : formatResult(r));
    } catch (e) {
      failed = true;
      console.error(`${t}: ERROR - ${(e as Error).message}`);
    }
  }
  return failed ? 2 : 0;
}

main().then((code) => process.exit(code));
