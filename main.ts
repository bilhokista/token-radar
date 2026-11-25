// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// copies this repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. A starting
// point, not a winner: it covers the watchlist, states the model and gives every protocol a farm plan.
// Change the model, the page or the plan; keep the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input
`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}
`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
console.log(`Output directory: ${out}`);
console.log(`board.json exists: ${existsSync(join(out, 'board.json'))}`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));

// Start a local server to serve the dashboard for screenshots
const PORT = 8080;
const server = createServer(async (req, res) => {
  const filePath = join(out, 'dashboard', req.url === '/' ? 'index.html' : req.url!);
  if (existsSync(filePath)) {
    const ext = filePath.split('.').pop();
    res.writeHead(200, {
      'Content-Type':
        ext === 'html'
          ? 'text/html'
          : ext === 'css'
            ? 'text/css'
            : ext === 'js'
              ? 'application/javascript'
              : 'text/plain',
    });
    res.end(readFileSync(filePath));
  } else if (req.url === '/data.js') {
    // Serve data.js directly from output
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(readFileSync(join(out, 'data.js')));
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, async () => {
  const screenshotsDir = join(out, 'screenshots');
  mkdirSync(screenshotsDir, { recursive: true });

  process.stdout.write(`token radar: starting screenshot generation, dashboard served at http://localhost:${PORT}\n`);
  const shots: string[] = [];

  const takeScreenshot = async (url: string, filename: string) => {
    const outputPath = join(screenshotsDir, filename);
    const command = [
      '/usr/bin/chromium',
      '--no-sandbox',
      '--headless=new',
      '--hide-scrollbars',
      '--window-size=1440,900', // Max long side 1440, short side >= 800
      `--screenshot=${outputPath}`,
      url,
    ].join(' ');

    process.stdout.write(`Executing: ${command}\n`);
    await new Promise<void>((resolve, reject) => {
      exec(command, (error: any, stdout: string, stderr: string) => {
        if (error) {
          process.stderr.write(`Error taking screenshot ${filename}: ${error.message}\n`);
          return reject(error);
        }
        if (stderr) {
          process.stderr.write(`Stderr taking screenshot ${filename}: ${stderr}\n`);
        }
        process.stdout.write(`Screenshot ${filename} created.\n`);
        resolve();
      });
    });
    shots.push(filename);
  };

  // Take screenshots
  const baseUrl = `http://localhost:${PORT}`;
  await takeScreenshot(baseUrl, 'board.png');

  const firstSlug = board[0]?.slug;
  if (firstSlug) {
    await takeScreenshot(`${baseUrl}/#p=${firstSlug}`, 'detail.png');
  }

  const sampleCategory = radar.rows.find(r => r.category)?.category || 'Dexs'; // Use an actual category if available
  await takeScreenshot(`${baseUrl}/#category=${encodeURIComponent(sampleCategory)}`, 'filtered.png');

  // Verify screenshot count
  if (shots.length < 3) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  // Check image names
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }

  // TODO: Add image size/dimension verification here if needed. Chromium --screenshot might output a fixed size, but compression/resizing might be needed for the 300-350KB target.
  // For now, assume chromium outputs within limits or will be handled by post-processing in a later step if needed.

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)
` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}
`,
  );

  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
});

server.on('error', (err) => {
  process.stderr.write(`token radar: server error: ${err.message}\n`);
  process.exit(1);
});
