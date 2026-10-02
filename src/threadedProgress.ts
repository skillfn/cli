import chalk from "chalk";

type SlotState = { label?: string; status: "idle" | "running"; startedAt?: number };

/**
 * Multi-line "threaded" progress, one row per concurrent worker -- modeled on `uv`'s own
 * install output, which shows several in-flight downloads at once rather than collapsing
 * them into a single rotating line. A plain spinner hides that work is actually happening
 * in parallel; this shows it, the same way uv's own output does.
 *
 * Redraws in place via ANSI cursor movement, so it only makes sense on a real TTY --
 * non-interactive/piped output (CI, redirected to a file) falls back to a plain sequential
 * log line per start/finish instead, since cursor-repositioning codes would just corrupt a
 * non-terminal stream.
 */
export class ThreadedProgress {
  private readonly slots: SlotState[];
  private readonly output: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private readonly total: number;
  private done = 0;
  private linesPrinted = 0;
  private timer?: NodeJS.Timeout;

  constructor(total: number, concurrency: number, output: NodeJS.WriteStream = process.stderr) {
    this.total = total;
    this.output = output;
    this.interactive = Boolean(output.isTTY) && !process.env.CI;
    this.slots = Array.from({ length: concurrency }, () => ({ status: "idle" as const }));
  }

  start(): void {
    if (!this.interactive) return;
    this.output.write("\x1B[?25l");
    this.render();
    this.timer = setInterval(() => this.render(), 150);
  }

  assign(lane: number, label: string): void {
    this.slots[lane] = { label, status: "running", startedAt: Date.now() };
    if (!this.interactive) this.output.write(`  ${chalk.dim("○")} Scanning ${label}\n`);
  }

  complete(lane: number, ok: boolean): void {
    const label = this.slots[lane].label ?? "";
    this.done++;
    if (!this.interactive) {
      this.output.write(`  ${ok ? chalk.green("✓") : chalk.red("✗")} ${label}${ok ? "" : chalk.dim(" (failed)")}\n`);
    }
    this.slots[lane] = { status: "idle" };
  }

  /**
   * Flushes a finished result above the live progress block instead of waiting for
   * everything to finish -- the progress rows stay pinned at the bottom (cleared and
   * redrawn below whatever was just printed), the same sticky-footer pattern build tools
   * like cargo/docker compose use. Only ThreadedProgress ever moves the cursor, so this and
   * the live redraw can't race each other into a corrupted screen.
   */
  print(text: string): void {
    if (this.interactive) this.clear();
    this.output.write(`${text}\n`);
    if (this.interactive) this.render();
  }

  stop(finalMessage: string): void {
    if (this.timer) clearInterval(this.timer);
    if (this.interactive) {
      this.clear();
      this.output.write("\x1B[?25h");
    }
    this.output.write(`${chalk.green("✓")} ${finalMessage}\n`);
  }

  private clear(): void {
    if (this.linesPrinted > 0) {
      this.output.write(`\x1B[${this.linesPrinted}A\x1B[0J`);
    }
    this.linesPrinted = 0;
  }

  private render(): void {
    this.clear();
    const lines: string[] = [chalk.dim(`Scanning skills — ${this.done}/${this.total} done`)];
    for (const slot of this.slots) {
      if (slot.status === "running" && slot.label !== undefined) {
        const elapsed = Math.max(0, Math.floor((Date.now() - (slot.startedAt ?? Date.now())) / 1000));
        lines.push(`  ${chalk.cyan("◐")} ${slot.label} ${chalk.dim(`[${elapsed}s]`)}`);
      } else {
        lines.push(chalk.dim("  ·"));
      }
    }
    for (const line of lines) this.output.write(`${line}\n`);
    this.linesPrinted = lines.length;
  }
}
