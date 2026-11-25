# Accessibility

release-lint is a command-line tool, and its output should work for everyone, whatever terminal, screen reader or
color vision they use.

- **Never color alone.** Every finding starts with a text label (`ERROR`, `WARN`, `INFO`) and its rule ID; color only
  repeats that.
- **No color when you don't want it.** `--no-color` and the [`NO_COLOR`](https://no-color.org) environment variable
  turn it off; it is also off when the output is not a terminal.
- **Plain text, no layout tricks.** No tables, spinners or cursor movement in the terminal report, so it reads in order
  with a screen reader and copies cleanly.
- **Machine-readable output.** `--json` gives the same findings for your own tools, and in GitHub Actions they also
  appear as annotations and as a table in the job summary.

If something is hard to use for you, please open an issue: accessibility problems are bugs.
