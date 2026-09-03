/** A weekly count belongs to the most recent Saturday in Lagos. */
export function stockCountWeek(lagosDate: string): string {
  const date = new Date(`${lagosDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 1) % 7));
  return date.toISOString().slice(0, 10);
}

export function shiftCountWeek(saturday: string, weeks: number): string {
  const date = new Date(`${saturday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}
