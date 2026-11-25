// Renders each example in readme/examples and keeps a block with its signatures,
// its code and its screenshot in README.md up to date.
//
// Usage: node scripts/readme-screenshots.js [options]
//   --renderer webgl|webgpu   which renderer to take the screenshots with
//   --only name,name          only handle these examples
//   --skip-screenshots        only update the README blocks
//   --check                   report what would change without writing anything
//   --readme path             the README to update, README.md by default
//
// An example is a whole sketch in readme/examples/<section>/<name>.js. It
// belongs to the #### heading in README.md named <name>. An item can have more
// examples, in <name>.<variant>.js. The plain <name>.js is the first one and the
// only one that shows the signatures, so it should be the simple, typical use.
// Examples without a
// title live in readme/examples/examples and go in the "### Examples" section
// instead. Signatures come from readme/signatures.json, a list of overloads per
// name.
//
// The only text this script ever writes in the README is the block between
// <!-- p5.sdf example: <id> --> and <!-- /p5.sdf example: <id> -->, where the id
// is the file name without .js. A new block goes at the end of the section, after
// the blocks already there, so everything written under a heading, including
// text before a block, is left as it is

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The one place to change which p5 the screenshots are rendered with
const P5_VERSION = '2.4.0';
const P5_URL = `https://cdn.jsdelivr.net/npm/p5@${P5_VERSION}/lib/p5.js`;
const P5_WEBGPU_URL = `https://cdn.jsdelivr.net/npm/p5@${P5_VERSION}/lib/p5.webgpu.js`;

const ROOT = path.resolve(__dirname, '..');
const EXAMPLES_DIR = path.join(ROOT, 'readme', 'examples');
const IMAGES_DIR = path.join(ROOT, 'readme', 'images');
const ASSETS_DIR = path.join(ROOT, 'readme', 'assets');
const SIGNATURES_PATH = path.join(ROOT, 'readme', 'signatures.json');
const ADDON_PATH = path.join(ROOT, 'p5.sdf.js');

const CANVAS_SIZE = 200;
// p5's default field of view fits the canvas height at a distance of 800, so
// this frames about 300 units in a 200 pixel canvas
const CAMERA_DISTANCE = 1200;
const PIXEL_DENSITY = 2;
const ITEM_HEADING_LEVEL = 4;
const SECTION_HEADING_LEVEL = 3;
// Examples in this directory have no title, so they go in the ### section
// of the same name. Any other example needs its own #### heading
const UNTITLED_DIRECTORY = 'examples';

function parseArgs(argv) {
  const options = {
    renderer: 'webgl',
    only: null,
    skipScreenshots: false,
    check: false,
    readme: path.join(ROOT, 'README.md'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--renderer') {
      options.renderer = argv[++i];
    } else if (arg === '--only') {
      options.only = new Set(argv[++i].split(',').map(name => name.trim()));
    } else if (arg === '--skip-screenshots') {
      options.skipScreenshots = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--readme') {
      options.readme = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  if (!['webgl', 'webgpu'].includes(options.renderer)) {
    throw new Error('--renderer must be webgl or webgpu');
  }
  return options;
}

function loadExamples(only) {
  const signatures = fs.existsSync(SIGNATURES_PATH)
    ? JSON.parse(fs.readFileSync(SIGNATURES_PATH, 'utf8'))
    : {};
  const examples = [];
  for (const section of fs.readdirSync(EXAMPLES_DIR).sort()) {
    const sectionDir = path.join(EXAMPLES_DIR, section);
    if (!fs.statSync(sectionDir).isDirectory()) {
      continue;
    }
    for (const file of fs.readdirSync(sectionDir).sort()) {
      if (!file.endsWith('.js')) {
        continue;
      }
      const id = path.basename(file, '.js');
      const name = id.split('.')[0];
      if (only && !only.has(name) && !only.has(id)) {
        continue;
      }
      examples.push({
        id,
        name,
        section,
        code: fs.readFileSync(path.join(sectionDir, file), 'utf8').trim(),
        signatures: id === name ? signatures[name] ?? [] : [],
        imageFile: path.join(IMAGES_DIR, section, `${id}.png`),
        imageSrc: `readme/images/${section}/${id}.png`,
      });
    }
  }
  const seen = new Map();
  for (const example of examples) {
    if (seen.has(example.id)) {
      throw new Error(`Two examples are named ${example.id}: ${seen.get(example.id)} and ${example.section}`);
    }
    seen.set(example.id, example.section);
  }
  // The plain <name>.js sorts before its variants, which then keep their order
  return examples.sort(
    (a, b) =>
      a.section.localeCompare(b.section) ||
      a.name.localeCompare(b.name) ||
      (b.id === b.name) - (a.id === a.name) ||
      a.id.localeCompare(b.id)
  );
}

////////////////////////
// SCREENSHOTS
////////////////////////

// The sketch runs as written. Only the camera is set for it, so that 3D shapes
// are not seen head on, and a WebGPU example is switched to that renderer.
// The sketch has to keep drawing: a WebGPU canvas that only draws once can come
// out blank in a screenshot
function pageHtml(example, renderer) {
  let code = example.code;
  if (renderer === 'webgpu') {
    const webgpuCode = code
      .replace(/(?<!async )function setup\(\)/, 'async function setup()')
      .replace(/createCanvas\(([^)]*), WEBGL\)/, 'await createCanvas($1, WEBGPU)');
    if (!webgpuCode.includes('await createCanvas')) {
      throw new Error(`${example.id} can't be switched to WebGPU, it needs a setup() calling createCanvas(w, h, WEBGL)`);
    }
    code = webgpuCode;
  }
  const harness = `
const userDraw = draw
draw = function() {
  const distance = ${CAMERA_DISTANCE}
  const yaw = 0.6
  const pitch = 0.4
  camera(
    distance * Math.sin(yaw) * Math.cos(pitch),
    -distance * Math.sin(pitch),
    distance * Math.cos(yaw) * Math.cos(pitch),
    0, 0, 0,
    0, 1, 0
  )
  userDraw()
  window.__drawn = true
}
`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>body { margin: 0; overflow: hidden; }</style>
</head>
<body>
<script src="${P5_URL}"></script>
${renderer === 'webgpu' ? `<script src="${P5_WEBGPU_URL}"></script>` : ''}
<script src="file://${ADDON_PATH}"></script>
<script>${code}
${harness}</script>
</body>
</html>
`;
}

async function takeScreenshots(examples, renderer) {
  const puppeteer = require('puppeteer');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5sdf-readme-'));
  const failures = [];
  // headless: true gets the real GPU, which WebGPU needs. file access is
  // allowed because the page loads p5.sdf.js from disk
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files'],
  });
  try {
    for (const example of examples) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message.split('\n')[0]));
      await page.setViewport({
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        deviceScaleFactor: PIXEL_DENSITY,
      });
      try {
        const htmlPath = path.join(tmpDir, `${example.id}.html`);
        fs.writeFileSync(htmlPath, pageHtml(example, renderer));
        // Examples load files like images by relative path, as a reader's
        // sketch would, so the assets go next to the page
        if (fs.existsSync(ASSETS_DIR)) {
          for (const asset of fs.readdirSync(ASSETS_DIR)) {
            fs.copyFileSync(path.join(ASSETS_DIR, asset), path.join(tmpDir, asset));
          }
        }
        await page.goto(`file://${htmlPath}`);
        await page.waitForFunction('window.__drawn === true', { timeout: 30000 });
        // Two more frames, so the screenshot is of a presented frame
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (errors.length > 0) {
          throw new Error(errors[0]);
        }
        fs.mkdirSync(path.dirname(example.imageFile), { recursive: true });
        await page.screenshot({
          path: example.imageFile,
          clip: { x: 0, y: 0, width: CANVAS_SIZE, height: CANVAS_SIZE },
        });
        console.log(`screenshot  ${example.section}/${example.id}`);
      } catch (error) {
        failures.push(`${example.section}/${example.id}: ${errors[0] ?? error.message.split('\n')[0]}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return failures;
}

////////////////////////
// README
////////////////////////

const startMarker = name => `<!-- p5.sdf example: ${name} -->`;
const endMarker = name => `<!-- /p5.sdf example: ${name} -->`;

function blockLines(example) {
  const signatures = example.signatures.length > 0
    ? ['```', ...example.signatures, '```', '']
    : [];
  return [
    startMarker(example.id),
    ...signatures,
    '<table>',
    '<tr>',
    '<td>',
    '',
    '```js',
    ...example.code.split('\n'),
    '```',
    '',
    '</td>',
    '<td>',
    '',
    `<img src="${example.imageSrc}" width="${CANVAS_SIZE}" alt="${example.id} example">`,
    '',
    '</td>',
    '</tr>',
    '</table>',
    endMarker(example.id),
  ];
}

// Headings inside fenced code blocks are not headings
function findHeadings(lines) {
  const headings = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    const match = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) {
      const title = match[2].replace(/`/g, '');
      // "#### sphere(radius)" and "#### `sphere`" are both the item "sphere"
      const name = /^[A-Za-z_$][\w$]*/.exec(title)?.[0] ?? null;
      headings.push({ index, level: match[1].length, name, title });
    }
  });
  return headings;
}

// The heading an example belongs to: the #### named after it or, for an example
// without a title, the ### named after its directory
function findHeadingFor(headings, example) {
  if (example.section === UNTITLED_DIRECTORY) {
    return headings.filter(
      heading =>
        heading.level === SECTION_HEADING_LEVEL &&
        heading.title.toLowerCase() === example.section.toLowerCase()
    );
  }
  return headings.filter(
    heading => heading.level === ITEM_HEADING_LEVEL && heading.name === example.name
  );
}

function updateReadme(text, examples) {
  let lines = text.split('\n');
  const report = { updated: [], inserted: [], unchanged: [], unmatched: [], ambiguous: [] };

  for (const example of examples) {
    const headings = findHeadings(lines);
    const matches = findHeadingFor(headings, example);
    if (matches.length === 0) {
      report.unmatched.push(example.id);
      continue;
    }
    if (matches.length > 1) {
      report.ambiguous.push(example.id);
      continue;
    }
    const heading = matches[0];
    const next = headings.find(other => other.index > heading.index && other.level <= heading.level);
    const sectionEnd = next ? next.index : lines.length;
    const block = blockLines(example);

    const start = lines.findIndex(
      (line, index) => index > heading.index && index < sectionEnd && line.trim() === startMarker(example.id)
    );
    const end = start === -1
      ? -1
      : lines.findIndex((line, index) => index > start && index < sectionEnd && line.trim() === endMarker(example.id));

    if (start !== -1 && end !== -1) {
      if (lines.slice(start, end + 1).join('\n') === block.join('\n')) {
        report.unchanged.push(example.id);
      } else {
        lines = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
        report.updated.push(example.id);
      }
      continue;
    }

    // Without a block yet it goes at the end of the section, never right under
    // the heading, so the text written there stays above it
    let insertAt = sectionEnd;
    while (insertAt - 1 > heading.index && lines[insertAt - 1].trim() === '') {
      insertAt--;
    }
    const inserted = ['', ...block];
    if (insertAt < lines.length && lines[insertAt].trim() !== '') {
      inserted.push('');
    }
    lines = [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)];
    report.inserted.push(example.id);
  }

  return { text: lines.join('\n'), report };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const examples = loadExamples(options.only);
  let failures = [];

  if (!options.check && !options.skipScreenshots) {
    failures = await takeScreenshots(examples, options.renderer);
  }

  const missingImages = examples.filter(example => !fs.existsSync(example.imageFile));
  for (const example of missingImages) {
    console.log(`missing image  ${example.imageSrc}`);
  }

  if (!fs.existsSync(options.readme)) {
    console.log(`${path.relative(ROOT, options.readme)} does not exist, so no blocks were written`);
  } else {
    const original = fs.readFileSync(options.readme, 'utf8');
    const { text, report } = updateReadme(original, examples);
    const verb = options.check ? 'would be' : 'was';
    for (const name of report.inserted) {
      console.log(`block ${verb} inserted  ${name}`);
    }
    for (const name of report.updated) {
      console.log(`block ${verb} updated   ${name}`);
    }
    if (report.unmatched.length > 0) {
      console.log(`no heading for examples: ${report.unmatched.join(', ')}`);
    }
    if (report.ambiguous.length > 0) {
      console.log(`more than one heading for examples: ${report.ambiguous.join(', ')}`);
    }
    const changed = report.inserted.length + report.updated.length > 0;
    if (changed && !options.check) {
      fs.writeFileSync(options.readme, text);
    }
    if (options.check && (changed || missingImages.length > 0)) {
      process.exitCode = 1;
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`failed  ${failure}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { updateReadme, findHeadings, blockLines };
