import { styleText } from 'node:util';
import type { AppModel, Finding, Severity } from './types.js';

type Style = Parameters<typeof styleText>[0];

const LABELS: Record<Severity, { text: string; style: Style }> = {
  error: { text: 'ERROR', style: ['bold', 'red'] },
  warning: { text: 'WARN ', style: ['bold', 'yellow'] },
  info: { text: 'INFO ', style: ['bold', 'cyan'] },
};
const INDENT = '        ';

/**
 * Strings from the app (hosts, entry names, bundle IDs) are untrusted: ANSI escapes could hide findings, a newline
 * could start a GitHub Actions `::command::` line, bidi overrides could disguise a host. Shown escaped, not stripped.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export const clean = (text: string) => text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const count = (findings: Finding[], severity: Severity) => findings.filter((f) => f.severity === severity).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function engine(app: AppModel): string {
  if (!app.bundle) return 'no JS bundle';
  return app.bundle.kind === 'hermes' ? `Hermes v${app.bundle.hermesVersion}` : 'JavaScript bundle (no Hermes)';
}

/** The human report: a header line, each finding with evidence, location and fix, and a summary. */
export function formatText(app: AppModel, findings: Finding[], { color, version }: { color: boolean; version: string }): string {
  // validateStream: false — whether to color is decided by the caller (TTY, NO_COLOR, --no-color).
  const paint = (style: Style, text: string) => (color ? styleText(style, text, { validateStream: false }) : text);
  const platform = app.platform === 'ios' ? 'iOS' : 'Android';
  const header = paint('bold', clean(`release-lint ${version} · ${app.file} · ${platform} · ${app.appId} ${app.version} (${app.build}) · ${engine(app)}`));

  if (findings.length === 0) {
    return `${header}\n\n${paint('green', 'No release problems found.')}\n`;
  }
  const body = findings.map((f) => {
    const label = LABELS[f.severity];
    return [
      ` ${paint(label.style, label.text)}  ${paint('bold', clean(f.ruleId))}  ${clean(f.message)}`,
      `${INDENT}${clean(f.evidence)}  ${paint('dim', `(${clean(f.location)})`)}`,
      `${INDENT}${paint('dim', `fix: ${clean(f.fix)}`)}`,
    ].join('\n');
  });
  const summary = `${plural(count(findings, 'error'), 'error')} · ${plural(count(findings, 'warning'), 'warning')} · ${count(findings, 'info')} info`;
  return `${header}\n\n${body.join('\n\n')}\n\n ${summary}\n`;
}

/** The machine report for CI and agents. Evidence is masked exactly as in the text report. */
export function formatJson(app: AppModel, findings: Finding[], version: string): string {
  const { bundle } = app;
  const report = {
    tool: 'release-lint',
    version,
    app: {
      file: app.file,
      platform: app.platform,
      appId: app.appId,
      version: app.version,
      build: app.build,
      bundle: bundle ? { file: bundle.file, kind: bundle.kind, hermesVersion: bundle.hermesVersion ?? null, approximate: bundle.approximate } : null,
    },
    findings,
    summary: { errors: count(findings, 'error'), warnings: count(findings, 'warning'), info: count(findings, 'info') },
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
