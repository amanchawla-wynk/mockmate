import type { FileHandle } from 'node:fs/promises';

type ObjectState = 'keyOrEnd' | 'key' | 'colon' | 'value' | 'commaOrEnd';
type ArrayState = 'valueOrEnd' | 'value' | 'commaOrEnd';
type Container =
  | { type: 'object'; state: ObjectState }
  | { type: 'array'; state: ArrayState };
type Mode = 'normal' | 'string' | 'escape' | 'unicode' | 'literal' | 'number';
type NumberState = 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponentSign' | 'exponentDigits';

function isJsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

class JsonSyntaxValidator {
  private readonly stack: Container[] = [];
  private rootState: 'value' | 'end' = 'value';
  private mode: Mode = 'normal';
  private stringRole: 'key' | 'value' = 'value';
  private unicodeRemaining = 0;
  private literal = '';
  private literalIndex = 0;
  private numberState: NumberState = 'zero';

  write(text: string): void {
    let index = 0;
    while (index < text.length) {
      if (!this.consume(text[index])) index += 1;
    }
  }

  finish(): void {
    if (this.mode === 'number') this.finishNumber();
    if (this.mode !== 'normal' || this.stack.length !== 0 || this.rootState !== 'end') {
      throw new SyntaxError('Incomplete JSON value');
    }
  }

  private consume(character: string): boolean {
    if (this.mode === 'string') return this.consumeString(character);
    if (this.mode === 'escape') return this.consumeEscape(character);
    if (this.mode === 'unicode') return this.consumeUnicode(character);
    if (this.mode === 'literal') return this.consumeLiteral(character);
    if (this.mode === 'number') return this.consumeNumber(character);

    if (isJsonWhitespace(character)) return false;
    const container = this.stack.at(-1);
    const expected = container?.state ?? this.rootState;

    if (expected === 'end') throw new SyntaxError('Trailing JSON data');
    if (expected === 'colon') {
      if (character !== ':') throw new SyntaxError('Expected colon');
      (container as Extract<Container, { type: 'object' }>).state = 'value';
      return false;
    }
    if (expected === 'commaOrEnd') {
      if (character === ',') {
        if (container?.type === 'object') container.state = 'key';
        else if (container?.type === 'array') container.state = 'value';
        else throw new SyntaxError('Unexpected comma');
        return false;
      }
      if (container?.type === 'object' && character === '}') return this.closeContainer();
      if (container?.type === 'array' && character === ']') return this.closeContainer();
      throw new SyntaxError('Expected comma or container end');
    }
    if (expected === 'keyOrEnd' || expected === 'key') {
      if (expected === 'keyOrEnd' && character === '}') return this.closeContainer();
      if (character !== '"') throw new SyntaxError('Expected object key');
      this.mode = 'string';
      this.stringRole = 'key';
      return false;
    }
    if (expected === 'valueOrEnd' && character === ']') return this.closeContainer();

    return this.startValue(character);
  }

  private startValue(character: string): boolean {
    if (character === '{') {
      this.stack.push({ type: 'object', state: 'keyOrEnd' });
      return false;
    }
    if (character === '[') {
      this.stack.push({ type: 'array', state: 'valueOrEnd' });
      return false;
    }
    if (character === '"') {
      this.mode = 'string';
      this.stringRole = 'value';
      return false;
    }
    if (character === 't' || character === 'f' || character === 'n') {
      this.mode = 'literal';
      this.literal = character === 't' ? 'true' : character === 'f' ? 'false' : 'null';
      this.literalIndex = 1;
      return false;
    }
    if (character === '-') {
      this.mode = 'number';
      this.numberState = 'minus';
      return false;
    }
    if (character === '0') {
      this.mode = 'number';
      this.numberState = 'zero';
      return false;
    }
    if (/[1-9]/.test(character)) {
      this.mode = 'number';
      this.numberState = 'integer';
      return false;
    }
    throw new SyntaxError('Expected JSON value');
  }

  private consumeString(character: string): boolean {
    if (character === '"') {
      this.mode = 'normal';
      if (this.stringRole === 'key') {
        const container = this.stack.at(-1);
        if (container?.type !== 'object') throw new SyntaxError('Unexpected object key');
        container.state = 'colon';
      } else {
        this.completeValue();
      }
      return false;
    }
    if (character === '\\') {
      this.mode = 'escape';
      return false;
    }
    if (character.charCodeAt(0) < 0x20) throw new SyntaxError('Control character in string');
    return false;
  }

  private consumeEscape(character: string): boolean {
    if ('"\\/bfnrt'.includes(character)) {
      this.mode = 'string';
      return false;
    }
    if (character === 'u') {
      this.mode = 'unicode';
      this.unicodeRemaining = 4;
      return false;
    }
    throw new SyntaxError('Invalid string escape');
  }

  private consumeUnicode(character: string): boolean {
    if (!/[a-fA-F0-9]/.test(character)) throw new SyntaxError('Invalid Unicode escape');
    this.unicodeRemaining -= 1;
    if (this.unicodeRemaining === 0) this.mode = 'string';
    return false;
  }

  private consumeLiteral(character: string): boolean {
    if (character !== this.literal[this.literalIndex]) throw new SyntaxError('Invalid JSON literal');
    this.literalIndex += 1;
    if (this.literalIndex === this.literal.length) {
      this.mode = 'normal';
      this.completeValue();
    }
    return false;
  }

  private consumeNumber(character: string): boolean {
    if (this.numberState === 'minus') {
      if (character === '0') this.numberState = 'zero';
      else if (/[1-9]/.test(character)) this.numberState = 'integer';
      else throw new SyntaxError('Invalid number');
      return false;
    }
    if (this.numberState === 'zero') {
      if (character === '.') this.numberState = 'dot';
      else if (character === 'e' || character === 'E') this.numberState = 'exponent';
      else return this.finishNumberAndReprocess(character);
      return false;
    }
    if (this.numberState === 'integer') {
      if (/[0-9]/.test(character)) return false;
      if (character === '.') this.numberState = 'dot';
      else if (character === 'e' || character === 'E') this.numberState = 'exponent';
      else return this.finishNumberAndReprocess(character);
      return false;
    }
    if (this.numberState === 'dot') {
      if (!/[0-9]/.test(character)) throw new SyntaxError('Invalid number fraction');
      this.numberState = 'fraction';
      return false;
    }
    if (this.numberState === 'fraction') {
      if (/[0-9]/.test(character)) return false;
      if (character === 'e' || character === 'E') this.numberState = 'exponent';
      else return this.finishNumberAndReprocess(character);
      return false;
    }
    if (this.numberState === 'exponent') {
      if (character === '+' || character === '-') this.numberState = 'exponentSign';
      else if (/[0-9]/.test(character)) this.numberState = 'exponentDigits';
      else throw new SyntaxError('Invalid number exponent');
      return false;
    }
    if (this.numberState === 'exponentSign') {
      if (!/[0-9]/.test(character)) throw new SyntaxError('Invalid number exponent');
      this.numberState = 'exponentDigits';
      return false;
    }
    if (/[0-9]/.test(character)) return false;
    return this.finishNumberAndReprocess(character);
  }

  private finishNumberAndReprocess(character: string): boolean {
    if (!isJsonWhitespace(character) && character !== ',' && character !== ']' && character !== '}') {
      throw new SyntaxError('Invalid number delimiter');
    }
    this.finishNumber();
    return true;
  }

  private finishNumber(): void {
    if (!['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.numberState)) {
      throw new SyntaxError('Incomplete number');
    }
    this.mode = 'normal';
    this.completeValue();
  }

  private closeContainer(): boolean {
    this.stack.pop();
    this.completeValue();
    return false;
  }

  private completeValue(): void {
    const container = this.stack.at(-1);
    if (!container) {
      if (this.rootState !== 'value') throw new SyntaxError('Unexpected JSON value');
      this.rootState = 'end';
      return;
    }
    if (container.state !== 'value' && container.state !== 'valueOrEnd') {
      throw new SyntaxError('Unexpected JSON value');
    }
    container.state = 'commaOrEnd';
  }
}

export async function validateJsonHandle(handle: FileHandle): Promise<void> {
  const parser = new JsonSyntaxValidator();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;

  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    parser.write(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
  }
  parser.write(decoder.decode());
  parser.finish();
}
