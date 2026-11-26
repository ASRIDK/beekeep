import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Makes sure no bee outlives the server. See warden-process.ts. */
export class Warden {
  private child: ChildProcess;

  constructor(command: string) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL(`./warden-process.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)), command], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    this.child.on('error', () => {});
    this.child.stdin!.on('error', () => {});
    this.child.unref();
  }

  /** Whether the warden is on duty. Bees must not start without it. */
  get alive(): boolean {
    return this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  watch(bee: ChildProcess): void {
    if (bee.pid === undefined) return;
    this.child.stdin!.write(`+${bee.pid}\n`);
    bee.once('exit', () => this.child.stdin!.write(`-${bee.pid}\n`));
  }

  /** Lets the warden finish: it ends any bee still alive. */
  dismiss(): void {
    this.child.stdin!.end();
  }
}
