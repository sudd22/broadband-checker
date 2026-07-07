


export function normalizePostcode(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}


export function formatPostcode(input: string): string {
  const n = normalizePostcode(input);
  if (n.length < 5) return n;
  return `${n.slice(0, n.length - 3)} ${n.slice(n.length - 3)}`;
}


const UK_POSTCODE_RE =
  /^(GIR ?0AA|[A-Z]{1,2}[0-9][0-9A-Z]? ?[0-9][A-Z]{2})$/i;

export function isStructurallyValidPostcode(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return UK_POSTCODE_RE.test(trimmed);
}
