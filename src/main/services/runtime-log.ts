import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';

const { LOG_MAX_BYTES, LOG_FILES, LOG_LINE_BYTES, LOG_MESSAGE_CHARS, LOG_PENDING_BYTES, LOG_FLUSH_MS } = RUNTIME_BOUNDS;

/** Bounded, rotating diagnostics. Logging never blocks the action loop on disk. */
export class RuntimeLog {
  private pending: string[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly maxBytes: number = LOG_MAX_BYTES,
    private readonly files: number = LOG_FILES,
  ) {}

  write(level: string, message: string, meta?: unknown): void {
    if (this.closed) return;
    let line: string;
    try {
      line = `${JSON.stringify({ at: Date.now(), level, message, meta })}\n`;
    } catch {
      line = `${JSON.stringify({ at: Date.now(), level, message, meta: '[unserializable]' })}\n`;
    }
    // A corrupt payload or repeated failing loop must not exhaust memory/disk.
    if (Buffer.byteLength(line) > LOG_LINE_BYTES) {
      line = `${JSON.stringify({ at: Date.now(), level, message: message.slice(0, LOG_MESSAGE_CHARS), truncated: true })}\n`;
    }
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > LOG_PENDING_BYTES) { this.dropped++; return; }
    this.pending.push(line);
    this.pendingBytes += bytes;
    if (this.timer === null) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, LOG_FLUSH_MS);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing !== null) {
      await this.flushing;
      if (this.pending.length > 0) await this.flush();
      return;
    }
    if (this.pending.length === 0 && this.dropped === 0) return;
    const batch = this.pending.join('') + (this.dropped > 0
      ? `${JSON.stringify({ at: Date.now(), level: 'warn', message: 'diagnostic queue overflow', dropped: this.dropped })}\n`
      : '');
    this.pending = [];
    this.pendingBytes = 0;
    this.dropped = 0;
    this.flushing = this.append(batch).catch((error: unknown) => {
      // Do not recurse through the logger when its disk is unavailable.
      console.error('runtime log write failed', String(error));
    });
    try { await this.flushing; } finally { this.flushing = null; }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async append(batch: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'runtime.jsonl');
    const size = await stat(file).then((s) => s.size, (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return 0;
      throw e;
    });
    if (size + Buffer.byteLength(batch) > this.maxBytes) {
      for (let i = this.files - 1; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        const to = `${file}.${i}`;
        if (i === this.files - 1) await unlink(to).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        await rename(from, to).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    }
    await appendFile(file, batch, { encoding: 'utf8', mode: 0o600 });
  }
}
