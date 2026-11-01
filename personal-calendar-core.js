// Shared calendar/audience logic. No Firebase or browser dependencies.
export function asDate(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function localDayKey(value) {
  const date = asDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isSessionForMember(session, member) {
  if (!member?.uid || session.status === "cancelled") return false;
  if (Array.isArray(session.targetMemberUids) && session.targetMemberUids.includes(member.uid)) return true;
  const roleMatches = session.audienceRole === "all" || session.audienceRole === member.role;
  const universityMatches = !session.audienceUniversityTag || session.audienceUniversityTag === member.universityTag;
  return roleMatches && universityMatches;
}

export function calendarStatus(event, now = new Date()) {
  if (["coming", "done", "missed"].includes(event.status)) return event.status;
  if (event.sessionStatus === "ended") return "missed";
  const end = asDate(event.endsAt) || asDate(event.startsAt);
  return end && end.getTime() <= now.getTime() ? "missed" : "coming";
}

export function sessionToEvent(session, override = {}) {
  const start = asDate(session.startsAt);
  if (!start || override.hidden || session.status === "cancelled") return null;
  return {
    id: `session:${session.id}`, sourceId: session.id, source: "session",
    title: session.title || "NawrasOnline session", notes: session.description || "",
    startsAt: start,
    endsAt: asDate(session.endsAt) || asDate(session.endedAt) || new Date(start.getTime() + 3600000),
    status: override.status || "auto", sessionStatus: session.status
  };
}

export function eventsOnDay(events, day) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return events.filter((event) => {
    const from = asDate(event.startsAt), to = asDate(event.endsAt) || from;
    return from && to && from < end && to > start;
  }).sort((a, b) => asDate(a.startsAt) - asDate(b.startsAt));
}

export function monthDays(month) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start); day.setDate(day.getDate() + index); return day;
  });
}
