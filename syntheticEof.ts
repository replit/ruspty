import { Transform } from 'node:stream';

// keep in sync with lib.rs::SYNTHETIC_EOF
export const SYNTHETIC_EOF = Buffer.from('\x1B]7878\x1B\\');

function getCommonPrefixLength(buffer: Buffer) {
  for (let prefixLen = SYNTHETIC_EOF.length; prefixLen >= 1; prefixLen--) {
    const suffix = buffer.subarray(buffer.length - prefixLen);
    const prefix = SYNTHETIC_EOF.subarray(0, prefixLen);

    if (suffix.equals(prefix)) {
      return prefixLen;
    }
  }
  return 0;
}

export class SyntheticEOFDetector extends Transform {
  buffer: Buffer;
  maxBufferSize: number;

  constructor(options = {}) {
    super(options);
    this.buffer = Buffer.alloc(0);
    this.maxBufferSize = SYNTHETIC_EOF.length - 1;
  }

  _transform(chunk: Buffer, encoding: string, callback: () => void) {
    // combine any leftover buffer with new chunk
    // and look for synthetic EOF in the combined data
    const searchData = Buffer.concat([this.buffer, chunk]);
    const eofIndex = searchData.indexOf(SYNTHETIC_EOF);

    // found EOF - emit data before it
    if (eofIndex !== -1) {
      const beforeEOF = searchData.subarray(0, eofIndex);
      const afterEOF = searchData.subarray(eofIndex + SYNTHETIC_EOF.length);

      if (beforeEOF.length > 0) {
        this.push(Buffer.from(beforeEOF));
      }

      this.emit('synthetic-eof');

      // Continue processing remaining data (might have more EOFs)
      if (afterEOF.length > 0) {
        this._transform(Buffer.from(afterEOF), encoding, callback);
        return;
      }

      this.buffer = Buffer.alloc(0);
    } else {
      // no EOF found - emit all the data except for the enough of a buffer
      // to potentially match the start of an EOF sequence next time
      const commonPrefixLen = getCommonPrefixLength(searchData);
      if (commonPrefixLen > 0) {
        // has common prefix - buffer the suffix, emit the rest
        const emitSize = searchData.length - commonPrefixLen;

        if (emitSize > 0) {
          const toEmit = searchData.subarray(0, emitSize);
          this.push(Buffer.from(toEmit));
        }

        this.buffer = Buffer.from(searchData.subarray(emitSize));
      } else {
        // no common prefix - emit everything, clear buffer
        this.push(Buffer.from(searchData));
        this.buffer = Buffer.alloc(0);
      }
    }

    callback();
  }

  _flush(callback: () => void) {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
    }

    callback();
  }
}
