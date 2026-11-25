#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { main } from './cli.js';

const color = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

// `release-lint app.ipa | head` closes the pipe early; that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
});

/** Only in a real terminal: CI, pipes and AI agents get a list and exit 2 instead of a prompt that never gets answered. */
async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);

main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd(), color, env: process.env, ...(interactive ? { ask } : {}) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `release-lint: unexpected error, please report it at https://github.com/harpreetkbadhan/release-lint/issues\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
