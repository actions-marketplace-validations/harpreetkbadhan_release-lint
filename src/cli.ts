import { readFileSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findBuilds, SEARCHED_FOLDERS } from './find-build.js';
import { readApp } from './formats/app.js';
import { formatAnnotations, formatJson, formatSarif, formatSummary, formatText } from './report.js';
import { runRules } from './rules.js';
import { ReleaseLintError, SEVERITIES, type AppModel, type Finding, type Severity } from './types.js';

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;
const DEFAULT_CONFIG = 'release-lint.config.json';
const FAIL_LEVELS: readonly string[] = [...SEVERITIES, 'none'];
const CONFIG_KEYS = ['failOn', 'allowHosts', 'ignore'];
const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const USAGE = `Usage: release-lint [app.ipa | app.aab | app.apk | App.xcarchive] [options]

Checks a built iOS or Android app for release mistakes: leaked secrets, staging and
localhost servers, staging deep links, the EAS Update channel, plain-HTTP network
settings, debug builds and source maps.
Only scan apps you own or have permission to audit.

Without a file, it looks for a release build in the project folder, build/, ios/build/
and android/app/build/outputs/ (release variants only).
On iOS it also reads an Xcode .app or .xcarchive folder, before export.

Options:
  --json               Print the report as JSON
  --sarif <path>       Also write a SARIF 2.1.0 report (GitHub code scanning)
  --fail-on <level>    Exit 1 when a finding is at least: error (default), warning, info, none
  --config <path>      Config file (default: ./${DEFAULT_CONFIG} if it exists)
  --ignore <rule>      Skip a rule, e.g. host/non-production or secret/* (repeatable)
  --no-color           Plain output
  -h, --help           Show this help
  -v, --version        Show the version
`;

type FailOn = Severity | 'none';

interface IgnoreRule {
  rule: string;
  match?: string;
}

export interface Config {
  failOn: FailOn;
  allowHosts: string[];
  ignore: IgnoreRule[];
}

export interface Io {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  cwd: string;
  /** Whether the terminal wants color; `--no-color` still turns it off. */
  color: boolean;
  /** Environment; `GITHUB_ACTIONS` / `GITHUB_STEP_SUMMARY` turn on annotations and the job summary. */
  env?: Record<string, string | undefined>;
  /** Asks the user a question in a terminal. Absent in CI, pipes and agents: then several found builds are an error. */
  ask?: (question: string) => Promise<string>;
}

/** Runs the CLI and returns the exit code: 0 clean, 1 findings at or above --fail-on, 2 unusable input. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (error) {
    if (error instanceof ReleaseLintError) {
      io.stderr.write(`release-lint: ${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        'fail-on': { type: 'string' },
        config: { type: 'string' },
        ignore: { type: 'string', multiple: true },
        'no-color': { type: 'boolean' },
        sarif: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new ReleaseLintError(`${(error as Error).message}\n\n${USAGE}`);
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (positionals.length > 1) {
    throw new ReleaseLintError(`give exactly one app file\n\n${USAGE}`);
  }
  const failOnFlag = values['fail-on'];
  if (failOnFlag !== undefined && !FAIL_LEVELS.includes(failOnFlag)) {
    throw new ReleaseLintError(`--fail-on must be one of ${FAIL_LEVELS.join(', ')}`);
  }

  if (values.sarif === '') {
    throw new ReleaseLintError('--sarif needs a file path');
  }
  if (values.config === '') {
    throw new ReleaseLintError('--config needs a file path');
  }
  const badRule = (values.ignore ?? []).find((rule) => !RULE_PATTERN.test(rule));
  if (badRule !== undefined) {
    throw new ReleaseLintError(`--ignore "${badRule}" is not a rule ID (e.g. host/non-production or secret/*)`);
  }
  const config = await loadConfig(io.cwd, values.config);
  const failOn = (failOnFlag as FailOn | undefined) ?? config.failOn;
  const ignore = [...config.ignore, ...(values.ignore ?? []).map((rule) => ({ rule }))];
  const file = positionals[0] ?? (await pickBuild(io));
  const app = await openApp(io.cwd, file);
  const findings = runRules(app, { allowHosts: config.allowHosts }).filter((f) => !isIgnored(f, ignore));

  const blocks = fails(findings, failOn);
  io.stdout.write(
    values.json ? formatJson(app, findings, VERSION) : formatText(app, findings, { color: io.color && !values['no-color'], version: VERSION, blocks, failOn }),
  );
  if (values.sarif !== undefined) {
    await writeSarif(io.cwd, values.sarif, file, findings);
  }
  if (!values.json && io.env?.['GITHUB_ACTIONS'] === 'true') {
    await reportToGitHub(app, findings, io);
  }
  return blocks ? EXIT_FINDINGS : EXIT_OK;
}

/** No file given: the only release build in the usual output folders, or the one the user picks in a terminal. */
async function pickBuild(io: Io): Promise<string> {
  const builds = await findBuilds(io.cwd);
  const [newest] = builds;
  if (newest === undefined) {
    throw new ReleaseLintError(`No app file given, and none found in ${SEARCHED_FOLDERS.join(', ')}\n\n${USAGE}`);
  }
  const file = builds.length === 1 ? newest.path : await choose(builds.map((b) => b.path), io);
  io.stderr.write(`release-lint: Scanning ${file}\n`);
  return file;
}

async function choose(paths: string[], io: Io): Promise<string> {
  const list = `Found ${paths.length} app files, newest first:\n${paths.map((p, i) => `  ${i + 1}) ${p}`).join('\n')}\n`;
  if (!io.ask) {
    throw new ReleaseLintError(`${list}Run release-lint <file> with the one to scan.`);
  }
  io.stderr.write(list);
  const answer = (await io.ask('Which one? [1] ').catch(() => {
    throw new ReleaseLintError('No build picked'); // Ctrl+C or Ctrl+D at the prompt is a choice, not a crash.
  })).trim();
  const index = answer === '' ? 0 : Number(answer) - 1;
  const chosen = Number.isInteger(index) ? paths[index] : undefined;
  if (chosen === undefined) {
    throw new ReleaseLintError(`Pick a number from 1 to ${paths.length}`);
  }
  return chosen;
}

/** The app file as SARIF expects it: relative to the working directory (the repository in CI), or a file:// URL. */
function artifactUri(cwd: string, file: string): string {
  const absolute = resolve(cwd, file);
  const rel = relative(cwd, absolute);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : pathToFileURL(absolute).href;
}

async function writeSarif(cwd: string, path: string, file: string, findings: Finding[]): Promise<void> {
  try {
    await writeFile(resolve(cwd, path), formatSarif(findings, VERSION, artifactUri(cwd, file)));
  } catch (error) {
    throw new ReleaseLintError(`could not write the SARIF file ${path} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
  }
}

/** Annotations on the run page and a table in the job summary. A summary write error never hides the result. */
async function reportToGitHub(app: AppModel, findings: Finding[], io: Io): Promise<void> {
  io.stdout.write(formatAnnotations(findings));
  const summaryPath = io.env?.['GITHUB_STEP_SUMMARY'];
  if (!summaryPath) return;
  try {
    await appendFile(summaryPath, formatSummary(app, findings, VERSION));
  } catch (error) {
    io.stderr.write(`release-lint: could not write the job summary (${(error as Error).message})\n`);
  }
}

/** Turns the usual file-system errors into a clean exit-2 message instead of an "unexpected error" stack trace. */
function fsError(error: unknown, what: string): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new ReleaseLintError(`${what} not found`);
  if (code === 'EISDIR') return new ReleaseLintError(`${what} is a directory`);
  if (code === 'EACCES' || code === 'EPERM') return new ReleaseLintError(`${what} is not readable (permission denied)`);
  if (code === 'ENOTDIR') return new ReleaseLintError(`${what}: a part of the path is not a directory`);
  return error;
}

async function openApp(cwd: string, file: string): Promise<AppModel> {
  try {
    return await readApp(resolve(cwd, file));
  } catch (error) {
    throw fsError(error, `File ${file}`);
  }
}

/** `host/non-production`, or a whole group: `secret/*`. */
const RULE_PATTERN = /^[a-z]+\/(\*|[a-z0-9-]+)$/;

const ruleMatches = (pattern: string, ruleId: string) => (pattern.endsWith('/*') ? ruleId.startsWith(pattern.slice(0, -1)) : pattern === ruleId);

const isIgnored = (finding: Finding, ignore: IgnoreRule[]) =>
  ignore.some(
    ({ rule, match }) => ruleMatches(rule, finding.ruleId) && (match === undefined || finding.evidence.includes(match) || finding.location.includes(match)),
  );

function fails(findings: Finding[], failOn: FailOn): boolean {
  if (failOn === 'none') return false;
  const threshold = SEVERITIES.indexOf(failOn);
  return findings.some((f) => SEVERITIES.indexOf(f.severity) >= threshold);
}

async function loadConfig(cwd: string, explicit: string | undefined): Promise<Config> {
  const name = explicit ?? DEFAULT_CONFIG;
  let text: string;
  try {
    text = await readFile(resolve(cwd, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fsError(error, `Config file ${name}`);
    if (explicit !== undefined) throw new ReleaseLintError(`Config file not found: ${explicit}`);
    return { failOn: 'error', allowHosts: [], ignore: [] };
  }
  try {
    return parseConfig(JSON.parse(text) as unknown, name);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ReleaseLintError(`${name}: invalid JSON (${error.message})`);
    throw error;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Validates the config strictly: a typo such as "allowHost" fails loudly instead of being ignored. */
export function parseConfig(raw: unknown, name: string): Config {
  const fail = (message: string) => new ReleaseLintError(`${name}: ${message}`);
  if (!isObject(raw)) throw fail('must be a JSON object');
  const unknown = Object.keys(raw).find((key) => !CONFIG_KEYS.includes(key));
  if (unknown) throw fail(`unknown key "${unknown}" (allowed: ${CONFIG_KEYS.join(', ')})`);

  const failOn = raw['failOn'] ?? 'error';
  if (typeof failOn !== 'string' || !FAIL_LEVELS.includes(failOn)) throw fail(`"failOn" must be one of ${FAIL_LEVELS.join(', ')}`);
  const allowHosts = raw['allowHosts'] ?? [];
  if (!isStringArray(allowHosts)) throw fail('"allowHosts" must be an array of host names');
  const ignore = raw['ignore'] ?? [];
  if (!Array.isArray(ignore)) throw fail('"ignore" must be an array of { "rule": "...", "match"?: "..." }');
  const rules = ignore.map((entry, i): IgnoreRule => {
    const valid =
      isObject(entry) &&
      typeof entry['rule'] === 'string' &&
      RULE_PATTERN.test(entry['rule']) &&
      (entry['match'] === undefined || typeof entry['match'] === 'string');
    if (!valid || Object.keys(entry).some((key) => key !== 'rule' && key !== 'match')) {
      throw fail(`"ignore[${i}]" must be { "rule": "...", "match"?: "..." }`);
    }
    return typeof entry['match'] === 'string' ? { rule: entry['rule'] as string, match: entry['match'] } : { rule: entry['rule'] as string };
  });
  return { failOn: failOn as FailOn, allowHosts, ignore: rules };
}
