export type SessionActivity = {
  modified?: string | Date;
  created?: string | Date;
  running?: boolean;
};

export function activityMs(session: SessionActivity): number {
  for (const value of [session.modified, session.created]) {
    if (!value) continue;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (Number.isFinite(time)) return time;
  }
  return session.running ? Date.now() : 0;
}

export function newestActivityFirst(
  a: SessionActivity,
  b: SessionActivity,
): number {
  return activityMs(b) - activityMs(a);
}
