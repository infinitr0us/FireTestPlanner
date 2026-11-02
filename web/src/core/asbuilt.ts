/** Survey poses and series copies. All planning consumers keep using transform. */
import { dot, forwardOf, sub } from './math';
import { displayName, positionOf, quatOf } from './plan';
import { isAimable, isVelocityProbe, type PlanDocument, type PlanObject, type Vec3 } from './types';

export function recordAsBuilt(obj: PlanObject): void {
  if (!obj.transform || obj.asBuilt) return;
  const today = new Date();
  const measured = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  obj.asBuilt = { transform: structuredClone(obj.transform), measured, note: null };
}

export function asBuiltProblem(obj: PlanObject): string | null {
  if (!('asBuilt' in obj)) return null;
  const a = obj.asBuilt;
  const vector = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x));
  if (!obj.transform || !a || typeof a !== 'object' || Array.isArray(a)) return 'As built requires a planned transform and a survey record.';
  if (Object.keys(a).some(k => !['transform', 'measured', 'note'].includes(k))) return 'Unknown as-built field.';
  const t = a.transform;
  if (!t || !vector(t.position_m, 3) || (t.rotation_quat !== undefined && !vector(t.rotation_quat, 4))
    || (t.aimTarget_m != null && !vector(t.aimTarget_m, 3))
    || Object.keys(t).some(k => !['position_m', 'rotation_quat', 'aimTarget_m'].includes(k))) return 'Invalid as-built transform.';
  if (a.note !== null && typeof a.note !== 'string') return 'As-built note must be text or null.';
  if (a.measured !== null) {
    if (typeof a.measured !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.measured)) return 'Measured date must be YYYY-MM-DD or null.';
    const d = new Date(a.measured + 'T00:00:00Z');
    if (a.measured.startsWith('0000') || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== a.measured) return 'Measured date is not a calendar date.';
  }
  return null;
}

export interface SetOutCheckRow {
  id: string; name: string; planned: Vec3; measured: Vec3;
  plan_distance_m: number; height_difference_m: number; aim_difference_deg: number | null; date: string | null;
}

export function setOutCheck(doc: PlanDocument): SetOutCheckRow[] {
  return doc.objects.flatMap(o => {
    if (!o.transform || !o.asBuilt) return [];
    const planned = positionOf(o), measured = o.asBuilt.transform.position_m;
    const delta = sub(measured, planned);
    const aimed = isAimable(o) && (!isVelocityProbe(o) || !!o.transform.rotation_quat && !!o.asBuilt.transform.rotation_quat);
    const cosine = aimed ? dot(forwardOf(quatOf(o)), forwardOf(quatOf({ ...o, transform: o.asBuilt.transform }))) : null;
    return [{ id: o.id, name: displayName(o), planned: [...planned] as Vec3, measured: [...measured] as Vec3,
      plan_distance_m: Math.hypot(delta[0], delta[1]), height_difference_m: delta[2],
      aim_difference_deg: cosine === null ? null : Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI,
      date: o.asBuilt.measured }];
  });
}

/** Decimal-string addition also works past the safe integer range. */
export function nextTestId(id: string | null | undefined): string {
  const text = id ?? '', match = /[0-9]+$/.exec(text);
  if (!match) return text + '-2';
  const digits = match[0].split('');
  let carry = 1;
  for (let i = digits.length - 1; i >= 0 && carry; i--) {
    const n = Number(digits[i]) + carry; digits[i] = String(n % 10); carry = n === 10 ? 1 : 0;
  }
  return text.slice(0, match.index) + (carry ? '1' : '') + digits.join('');
}

export function nextTest(doc: PlanDocument): PlanDocument {
  const result = structuredClone(doc), now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  result.meta = { ...result.meta, testId: nextTestId(result.meta?.testId), revision: null, created: now, modified: now };
  delete result.testData;
  result.objects = result.objects.filter(o => o.type !== 'reconstructedFlame');
  for (const o of result.objects) { delete o.linkedFiles; delete o.asBuilt; }
  return result;
}
