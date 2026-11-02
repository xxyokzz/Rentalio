import { Injectable, Optional } from '@nestjs/common';
import { redact } from './redact.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

type Sink = (line: string) => void;

/** Sink default: satu baris JSON ke stdout (mudah di-parse log collector). */
const stdoutSink: Sink = (line) => {
  // Test suite tidak perlu menulis ribuan baris log; unit test memakai sink sendiri.
  if (process.env.NODE_ENV === 'test' && process.env.RENTALIO_DEBUG_LOG !== '1') return;
  process.stdout.write(`${line}\n`);
};

/**
 * Logger terstruktur (JSON lines) dengan redaksi wajib.
 *
 * Semua field melewati `redact()` sehingga token, cookie, OTP, password, dan
 * secret tidak pernah tercetak — termasuk bila tersembunyi di dalam string
 * (mis. header Authorization mentah).
 */
@Injectable()
export class StructuredLogger {
  private readonly write: Sink;

  // `@Optional()` penting: NestJS dapat membuat logger ini lewat DI tanpa
  // argumen, sementara unit test menyuntikkan sink sendiri.
  constructor(@Optional() sink?: Sink) {
    this.write = sink ?? stdoutSink;
  }

  info(message: string, fields: LogFields = {}): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit('error', message, fields);
  }

  private emit(level: LogLevel, message: string, fields: LogFields): void {
    const sanitized = redact(fields);
    const entry: Record<string, unknown> = {
      ...(typeof sanitized === 'object' && sanitized !== null
        ? (sanitized as Record<string, unknown>)
        : { value: sanitized }),
      // Field tetap ditulis terakhir agar tidak dapat ditimpa oleh payload.
      level,
      time: new Date().toISOString(),
      service: 'rentalio-api',
      msg: message,
    };
    this.write(JSON.stringify(entry));
  }
}
