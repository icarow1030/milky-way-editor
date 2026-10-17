import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Splits one CSV line, honouring double quotes ("" escapes). Sufficient for HYG and Gaia TAP output. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Streams a CSV file, calling `row` with a column accessor for each data line. */
export async function readCsv(path: string, row: (get: (col: string) => string) => void): Promise<number> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: Map<string, number> | null = null;
  let fields: string[] = [];
  const get = (col: string) => {
    const i = header!.get(col);
    if (i === undefined) throw new Error(`Missing column ${col} in ${path}`);
    return fields[i] ?? '';
  };
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = new Map(splitCsvLine(line).map((h, i) => [h.trim(), i]));
      continue;
    }
    fields = splitCsvLine(line);
    row(get);
    n++;
  }
  return n;
}

export const num = (s: string): number => (s === '' ? NaN : Number(s));
