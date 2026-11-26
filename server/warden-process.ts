// Runs beside the server as its own process. The server tells it which bees are
// alive; when the server goes away for any reason, even kill -9, the pipe closes
// and the warden ends every bee left behind. No bee runs unwatched.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const bees = new Set<number>();
const command = process.argv[2] ?? '';

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const pid = Number(line.slice(1));
    if (!Number.isInteger(pid) || pid < 2) return;
    if (line[0] === '+') bees.add(pid);
    if (line[0] === '-') bees.delete(pid);
  })
  .on('close', () => {
    end('SIGTERM');
    setTimeout(() => {
      end('SIGKILL');
      process.exit(0);
    }, 2000);
  });

// The server's own signals must not take the warden down before it has done its job.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});

function end(signal: NodeJS.Signals): void {
  for (const pid of bees) {
    if (!isBee(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Process numbers get reused, so make sure this is still Claude Code. */
function isBee(pid: number): boolean {
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).startsWith(command);
  } catch {
    return false;
  }
}
