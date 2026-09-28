// Deliberately bad test subjects for checking the observer/oracles. The corpus
// cannot select this entry point; only the harness's own tests call it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.env.FUZZ_CASE_ROOT;
switch (process.argv[2]) {
  case 'delete': fs.unlinkSync(path.join(root, 'protected/secret')); break;
  case 'stream': fs.createWriteStream(path.join(root, 'protected/secret')); break;
  case 'promise': await fs.promises.writeFile(path.join(root, 'protected/secret'), 'bad'); break;
  case 'child': spawnSync('canary'); break;
  case 'crash': throw new Error('Deliberate uncaught control');
  // Synthetic canary only: proves the output-disclosure oracle fires.
  case 'leak': console.log(process.env.FUZZ_CANARY); break;
  case 'hang': setInterval(() => {}, 1000); break;
  default: throw new Error('Unknown oracle control');
}
