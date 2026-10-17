import type { NameRow } from '../core/format.ts';

const GREEK_NAMES: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota',
  κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau',
  υ: 'upsilon', φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
};

export const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_\-.]+/g, '');

export interface SearchHit {
  index: number;
  label: string;
  key: string;
  row: NameRow;
}

/** Tiny in-memory index over designations (built once, after names.json is fetched). */
export class StarSearch {
  private keys: string[] = [];
  private owners: number[] = []; // index into rows
  private labels: string[] = [];
  readonly byIndex = new Map<number, NameRow>();

  constructor(private rows: NameRow[]) {
    rows.forEach((r, i) => {
      this.byIndex.set(r[0], r);
      const [, proper, bf, , hip, hd, hr, gl] = r;
      if (proper) this.push(proper, proper, i);
      if (bf) {
        this.push(bf, bf, i);
        const latin = bf.replace(/[α-ω]/g, (g) => GREEK_NAMES[g] ?? g);
        if (latin !== bf) this.push(latin, bf, i);
      }
      if (hip) this.push(`hip${hip}`, `HIP ${hip}`, i);
      if (hd) this.push(`hd${hd}`, `HD ${hd}`, i);
      if (hr) this.push(`hr${hr}`, `HR ${hr}`, i);
      if (gl) this.push(gl, gl, i);
    });
  }

  private push(key: string, label: string, owner: number): void {
    this.keys.push(norm(key));
    this.labels.push(label);
    this.owners.push(owner);
  }

  query(q: string, limit = 12): SearchHit[] {
    const n = norm(q);
    if (!n) return [];
    const scored: Array<{ s: number; k: number }> = [];
    for (let k = 0; k < this.keys.length; k++) {
      const key = this.keys[k];
      let s: number;
      if (key === n) s = 0;
      else if (key.startsWith(n)) s = 1 + (key.length - n.length) * 0.01;
      else if (n.length >= 3 && key.includes(n)) s = 3;
      else continue;
      if (this.rows[this.owners[k]][1]) s -= 0.5; // proper names first
      scored.push({ s, k });
    }
    scored.sort((a, b) => a.s - b.s);
    const seen = new Set<number>();
    const out: SearchHit[] = [];
    for (const { k } of scored) {
      const row = this.rows[this.owners[k]];
      if (seen.has(row[0])) continue;
      seen.add(row[0]);
      out.push({ index: row[0], label: row[1] || this.labels[k], key: this.labels[k], row });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Rows with proper names (for sky labels). */
  named(): NameRow[] {
    return this.rows.filter((r) => r[1]);
  }
}
