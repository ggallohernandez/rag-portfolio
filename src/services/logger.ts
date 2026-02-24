export type LogContext = Record<string, unknown>;

export class Logger {
  info(message: string, context: LogContext = {}): void {
    // Structured log output used by tests and debug traces.
    console.log(JSON.stringify({ level: "info", message, ...context }));
  }

  error(message: string, context: LogContext = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...context }));
  }
}
