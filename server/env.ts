/** The person's environment, without traces of a Claude session Beekeep may have been started from. */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_JOB)/.test(key)) continue;
    out[key] = value;
  }
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Beekeep', LANG: out.LANG ?? 'en_US.UTF-8' };
}
