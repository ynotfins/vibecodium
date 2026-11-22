export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export const emptyString = '';

export let counter = 0;

export function nextCounter(): number {
  counter += 1;
  return counter;
}