import chalk from "chalk";
import type { Severity } from "./scanner/types.js";

/**
 * Shared, colored output helpers for the commands that print status/results directly
 * (scan, audit, doctor) rather than asking questions (which already go through
 * @clack/prompts). Keeps every command's terminal output visually consistent instead of
 * each one hand-rolling its own plain console.log formatting.
 *
 * Never used for --format json/sarif output -- those stay plain data, chalk or not.
 * chalk itself already disables color automatically when stdout isn't a TTY or
 * NO_COLOR/FORCE_COLOR say otherwise, so no extra detection is needed here.
 */

export function heading(text: string): string {
  return chalk.bold.cyan(text);
}

export function success(text: string): string {
  return `${chalk.green("✓")} ${text}`;
}

export function failure(text: string): string {
  return `${chalk.red("✗")} ${text}`;
}

export function warn(text: string): string {
  return `${chalk.yellow("!")} ${text}`;
}

export function dim(text: string): string {
  return chalk.dim(text);
}

const SEVERITY_COLOR: Record<Severity, (text: string) => string> = {
  critical: (t) => chalk.bgRed.white.bold(t),
  high: (t) => chalk.red.bold(t),
  medium: (t) => chalk.yellow.bold(t),
  low: (t) => chalk.blue(t),
  info: (t) => chalk.dim(t),
};

export function colorSeverity(severity: Severity): string {
  return SEVERITY_COLOR[severity](severity.toUpperCase());
}

export function passBanner(passed: boolean): string {
  return passed ? chalk.bgGreen.black.bold(" PASS ") : chalk.bgRed.white.bold(" FAIL ");
}
