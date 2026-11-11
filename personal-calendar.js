import {
  collection, doc, query, where, onSnapshot, addDoc, getDocs, updateDoc, setDoc, deleteDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { asDate, localDayKey, isSessionForMember, calendarStatus, sessionToEvent, eventsOnDay, monthDays } from "./personal-calendar-core.js";

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const dateTime = (value) => asDate(value)?.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) || "";
const localInput = (date) => `${localDayKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const STATUS_OPTIONS = [["auto", "Automatic (coming / missed)"], ["coming", "Coming"], ["done", "Done"], ["missed", "Missed"]];
const statusOptions = (selected) => STATUS_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");

export function createPersonalPlanner({ db, member, getState, navigate, toast }) {
  const root = document.getElementById("personalCalendarRoot");
  const overview = document.getElementById("dashboardOverviewRoot");
  if (!root || !overview) return { stop() {}, refreshOverview() {} };
  const stops = [], sessionSources = new Map(), errors = new Map();
  let manualEvents = [], academyEvents = [], overrides = new Map(), events = [], stopped = false;
  let selectedDay = new Date(), month = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
  let pending = false;
  const uid = member.uid;
  const personal = (name) => collection(db, "teamMembers", uid, name);
  const modal = document.createElement("dialog");
  modal.className = "planner-dialog";
  modal.setAttribute("aria-labelledby", "personalEventHeading");
  modal.innerHTML = `<form class="form-stack" id="personalEventForm">
    <div class="planner-dialog-heading"><h2 id="personalEventHeading">Add calendar event</h2><button type="button" class="planner-icon-button" data-close aria-label="Close event editor">×</button></div>
    <input name="id" type="hidden">
    <label>Title<input name="title" required maxlength="120" placeholder="What are you planning?"></label>
    <div class="planner-form-dates"><label>Starts<input name="startsAt" type="datetime-local" required></label><label>Ends<input name="endsAt" type="datetime-local" required></label></div>
    <label>Status<select name="status">${statusOptions("auto")}</select></label>
    <label>Notes<textarea name="notes" maxlength="2000" rows="3" placeholder="Optional notes"></textarea></label>
    <p class="planner-form-error" role="alert"></p><button class="btn btn-primary" type="submit">Save event</button>
  </form>`;
  document.body.appendChild(modal);
  const form = modal.querySelector("form");
  modal.querySelector("[data-close]").onclick = () => modal.close();
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.close(); });

  let academyModal = null, academyForm = null;
  if (member.role === "admin") {
    academyModal = document.createElement("dialog");
    academyModal.className = "planner-dialog";
    academyModal.setAttribute("aria-labelledby", "academyEventHeading");
    academyModal.innerHTML = `<form class="form-stack" id="academyEventForm">
      <div class="planner-dialog-heading"><h2 id="academyEventHeading">Publish academy event</h2><button type="button" class="planner-icon-button" data-close aria-label="Close event editor">×</button></div>
      <input name="id" type="hidden">
      <label>Event title<input name="title" required maxlength="120" placeholder="e.g. Academy orientation"></label>
      <label>Description<textarea name="description" maxlength="2000" rows="3" placeholder="Add the event details for members"></textarea></label>
      <div class="planner-form-dates"><label>Starts<input name="startsAt" type="datetime-local" required></label><label>Ends<input name="endsAt" type="datetime-local" required></label></div>
      <label>Audience<select name="audienceRole" required>
        <option value="all">All roles</option><option value="admin">Admins</option><option value="user">User</option><option value="leaders">Leaders</option>
        <option value="public">Public</option><option value="tech">Technical</option><option value="social">Social</option>
        <option value="designers">Designers</option><option value="content">Content</option><option value="event">Event</option>
      </select></label>
      <p class="planner-form-error" role="alert"></p><button class="btn btn-primary" type="submit">Publish event</button>
    </form>`;
    document.body.appendChild(academyModal);
    academyForm = academyModal.querySelector("form");
    academyModal.querySelector("[data-close]").onclick = () => academyModal.close();
    academyModal.addEventListener("click", (event) => { if (event.target === academyModal) academyModal.close(); });
  }

  function failure(source, error) {
    if (stopped) return;
    if (source.startsWith("sessions ")) sessionSources.delete(Number(source.split(" ").at(-1)) - 1);
    if (source === "personal events") manualEvents = [];
    if (source === "academy events") academyEvents = [];
    console.error(`Personal calendar ${source}:`, error?.code || error?.message);
    errors.set(source, `Could not sync ${source}. Check your connection and deploy the included Firestore rules and indexes.`);
    render();
  }
  function watch(source, ref, receive) {
    stops.push(onSnapshot(ref, (snapshot) => {
      if (stopped) return;
      errors.delete(source); receive(snapshot); render();
    }, (error) => failure(source, error)));
  }
  function rebuildEvents() {
    const sessions = new Map();
    sessionSources.forEach((items) => items.forEach((item) => sessions.set(item.id, item)));
    const sharedEvents = academyEvents.map((item) => {
      const override = overrides.get(`academy_${item.id}`) || {};
      return {
        id: `academy:${item.id}`, sourceId: item.id, source: "academy",
        audienceRole: item.audienceRole,
        title: item.title || "Academy event", notes: item.description || "",
        startsAt: item.startsAt, endsAt: item.endsAt, status: override.status || "auto",
        hidden: override.hidden === true
      };
    }).filter((item) => !item.hidden);
    events = [...manualEvents, ...sharedEvents, ...Array.from(sessions.values())
      .filter((session) => isSessionForMember(session, member))
      .map((session) => sessionToEvent(session, overrides.get(session.id)))
      .filter(Boolean)].sort((a, b) => asDate(a.startsAt) - asDate(b.startsAt));
  }
  function eventCard(event, compact = false) {
    const status = calendarStatus(event);
    const join = event.source === "session" && ["scheduled", "live"].includes(event.sessionStatus);
    const endLabel = localDayKey(event.endsAt) !== localDayKey(event.startsAt)
      ? dateTime(event.endsAt)
      : asDate(event.endsAt)?.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `<article class="planner-event planner-event-${status}">
      <div class="planner-event-top"><span class="planner-status planner-status-${status}">${status === "coming" && event.sessionStatus === "live" ? "Live · coming" : status}</span><small>${event.source === "session" ? "NawrasOnline · synced" : event.source === "academy" ? "Academy · shared" : "Personal"}</small></div>
      <h3>${escape(event.title)}</h3><time>${escape(dateTime(event.startsAt))} – ${escape(endLabel)}</time>
      ${!compact && event.notes ? `<p>${escape(event.notes)}</p>` : ""}
      ${compact ? `<button type="button" class="planner-text-link" data-go="calendar" data-focus-date="${localDayKey(event.startsAt)}">View in calendar →</button>` : `<div class="planner-event-actions">
        <label class="planner-status-control"><span>Status</span><select data-event-status="${escape(event.id)}" aria-label="Status for ${escape(event.title)}">${statusOptions(event.status || "auto")}</select></label>
        ${join ? `<a class="btn btn-primary btn-compact" href="nawras-online.html?session=${encodeURIComponent(event.sourceId)}">Open session ↗</a>` : ""}
        ${event.source === "personal" || (event.source === "academy" && member.role === "admin") ? `<button type="button" class="btn btn-outline btn-compact" data-edit-event="${escape(event.id)}">Edit</button>` : ""}
        ${event.source === "academy" && member.role === "admin"
          ? `<button type="button" class="planner-text-link planner-danger" data-delete-event="${escape(event.id)}">Delete for everyone</button>`
          : `<button type="button" class="planner-text-link planner-danger" data-delete-event="${escape(event.id)}">${event.source === "personal" ? "Delete" : "Remove from my calendar"}</button>`}</div>`}
    </article>`;
  }
  function render() {
    if (stopped) return;
    rebuildEvents();
    const today = localDayKey(new Date()), selected = localDayKey(selectedDay);
    const dayEvents = eventsOnDay(events, selectedDay);
    const hiddenCount = Array.from(overrides.values()).filter((item) => item.hidden).length;
    root.innerHTML = `<div class="planner-toolbar"><div><span class="panel-kicker">Your time, organised</span><h2>My calendar</h2><p>Matching sessions, academy events and your personal plans in one place.</p></div><div class="planner-toolbar-actions">${member.role === "admin" ? `<button type="button" class="btn btn-outline" data-add-academy-event>+ Publish academy event</button>` : ""}<button type="button" class="btn btn-primary" data-add-event>+ Add my event</button></div></div>
      ${errors.size ? `<div class="planner-sync-error" role="alert">${Array.from(errors.values()).map(escape).join("<br>")}</div>` : ""}
      <div class="planner-layout"><div class="planner-month">
        <div class="planner-month-heading"><h3>${escape(month.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</h3><div class="planner-month-controls"><button type="button" class="planner-icon-button" data-month="-1" aria-label="Previous month">‹</button><button type="button" class="planner-today-button" data-today>Today</button><button type="button" class="planner-icon-button" data-month="1" aria-label="Next month">›</button></div></div>
        <div class="planner-weekdays" aria-hidden="true">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => `<span>${day}</span>`).join("")}</div>
        <div class="planner-month-grid" role="group" aria-label="Choose a calendar date">${monthDays(month).map((day) => {
          const items = eventsOnDay(events, day), key = localDayKey(day);
          return `<button type="button" data-date="${key}" class="planner-day ${day.getMonth() !== month.getMonth() ? "is-outside" : ""} ${key === today ? "is-today" : ""} ${key === selected ? "is-selected" : ""}" aria-pressed="${key === selected}" ${key === today ? 'aria-current="date"' : ""} aria-label="${escape(day.toLocaleDateString(undefined, { dateStyle: "full" }))}, ${items.length} events"><span>${day.getDate()}</span><span class="planner-day-dots">${items.slice(0, 3).map((item) => `<i class="planner-dot-${calendarStatus(item)}"></i>`).join("")}${items.length > 3 ? "<b>+</b>" : ""}</span></button>`;
        }).join("")}</div>
        <div class="planner-legend"><span><i class="planner-dot-coming"></i>Coming</span><span><i class="planner-dot-done"></i>Done</span><span><i class="planner-dot-missed"></i>Missed</span></div>
        <p class="planner-footnote">Times use your device timezone. Automatic status becomes missed after the end time unless you mark it done.</p>
        ${hiddenCount ? `<button type="button" class="planner-text-link" data-restore>Restore hidden events (${hiddenCount})</button>` : ""}
      </div><div class="planner-agenda" aria-live="polite"><div class="planner-agenda-heading"><h3>${escape(selectedDay.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" }))}</h3><span>${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}</span></div>
         ${dayEvents.length ? dayEvents.map((event) => eventCard(event)).join("") : `<div class="planner-empty"><span>◷</span><h3>A little room in your day</h3><p>No events for this date. Add a personal plan or wait for a matching session.</p><button type="button" class="btn btn-outline" data-add-event>Add an event</button>${member.role === "admin" ? `<button type="button" class="btn btn-outline" data-add-academy-event>Publish academy event</button>` : ""}</div>`}
      </div></div>`;
    refreshOverview();
  }
  function refreshOverview() {
    if (stopped) return;
    const data = getState(), now = new Date();
    const unread = (data.inboxMessages || []).filter((item) => !item.read);
    const tasks = (data.tasks || []).filter((task) => task.status === "open" && (!data.taskSubmissions?.[task.id] || data.taskSubmissions[task.id].status === "rejected"));
    const coming = events.filter((event) => calendarStatus(event, now) === "coming" && asDate(event.endsAt) >= now).slice(0, 3);
    const courses = data.assignedCourses || [];
    const sections = data.sections || [];
    const shortName = String(member.displayName || member.name || "there").split(" ")[0];
    overview.innerHTML = `<div class="overview-intro"><div><span class="panel-kicker">${escape(now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))}</span><h2>Hello, ${escape(shortName)}.</h2><p>A clear view of what needs your attention.</p></div><button type="button" class="btn btn-primary" data-go="calendar">Open my calendar ↗</button></div>
      <div class="overview-stats">
        ${[["calendar", "Coming up", events.filter((item) => calendarStatus(item) === "coming" && asDate(item.endsAt) >= now).length, "◷"], ["tasks", "Open tasks", tasks.length, "✓"], ["my-courses", "My courses", courses.length, "▤"], ["inbox", "Unread updates", unread.length, "✉"]].map(([go, label, count, icon]) => `<button type="button" class="overview-stat" data-go="${go}"><span class="overview-stat-icon">${icon}</span><strong>${count}</strong><span>${label} <b>↗</b></span></button>`).join("")}
      </div><div class="overview-columns"><section class="overview-block"><div class="overview-block-heading"><h3>Coming up</h3><button type="button" class="planner-text-link" data-go="calendar">View calendar →</button></div>${coming.length ? coming.map((event) => eventCard(event, true)).join("") : `<div class="overview-empty">No upcoming events. Your matching sessions will appear here automatically.</div>`}${errors.size ? `<p class="planner-sync-error">Some calendar sources could not sync. Open your calendar for details.</p>` : ""}</section>
      <section class="overview-block"><div class="overview-block-heading"><h3>Focus on this</h3><button type="button" class="planner-text-link" data-go="tasks">Tasks →</button></div>${tasks.length ? tasks.slice(0, 3).map((task) => `<button type="button" class="overview-row" data-go="tasks"><span class="overview-row-icon">✓</span><span><strong>${escape(task.title || "Assigned task")}</strong><small>${escape(task.description || "Open tasks to see the details.").slice(0, 130)}</small></span><b>→</b></button>`).join("") : `<div class="overview-empty">No open tasks need your attention right now.</div>`}
      <div class="overview-block-heading"><h3>Latest updates</h3><button type="button" class="planner-text-link" data-go="inbox">Inbox →</button></div>${(data.inboxMessages || []).slice(0, 2).map((item) => `<button type="button" class="overview-row" data-go="inbox"><span class="overview-row-icon">${item.read ? "·" : "●"}</span><span><strong>${escape(item.title || "Team update")}</strong><small>${escape(item.message || "").slice(0, 130)}</small></span><b>→</b></button>`).join("") || `<div class="overview-empty">Your inbox is up to date.</div>`}</section></div>
      <section class="overview-block overview-shortcuts"><div class="overview-block-heading"><h3>Your workspace</h3><span>One click away</span></div><div class="overview-shortcut-grid">${sections.filter((section) => ["my-courses", "my-forms", "my-ratings", "technical-materials", "managed-team", "ratings", "forms", "attendance", "team-members", "chat"].includes(section.id)).map((section) => `<button type="button" data-go="${escape(section.id)}"><span>${section.icon}</span>${escape(section.label)}<b>↗</b></button>`).join("")}</div></section>`;
  }
  function openEditor(event) {
    form.reset();
    const start = event ? asDate(event.startsAt) : new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate(), 9);
    form.elements.id.value = event?.sourceId || "";
    form.elements.title.value = event?.title || "";
    form.elements.notes.value = event?.notes || "";
    form.elements.startsAt.value = localInput(start);
    form.elements.endsAt.value = localInput(event ? asDate(event.endsAt) : new Date(start.getTime() + 3600000));
    form.elements.status.value = event?.status || "auto";
    modal.querySelector("h2").textContent = event ? "Edit personal event" : "Add calendar event";
    form.querySelector("[role=alert]").textContent = "";
    modal.showModal();
  }
  function openAcademyEditor(event) {
    if (member.role !== "admin" || !academyModal || !academyForm) return;
    academyForm.reset();
    const start = event ? asDate(event.startsAt) : new Date(selectedDay.getFullYear(), selectedDay.getMonth(), selectedDay.getDate(), 9);
    academyForm.elements.id.value = event?.sourceId || "";
    academyForm.elements.title.value = event?.title || "";
    academyForm.elements.description.value = event?.notes || "";
    academyForm.elements.startsAt.value = localInput(start);
    academyForm.elements.endsAt.value = localInput(event ? asDate(event.endsAt) : new Date(start.getTime() + 3600000));
    academyForm.elements.audienceRole.value = event?.audienceRole || "all";
    academyModal.querySelector("h2").textContent = event ? "Edit academy event" : "Publish academy event";
    academyForm.querySelector("[role=alert]").textContent = "";
    academyModal.showModal();
  }
  async function changeStatus(event, status) {
    if (!STATUS_OPTIONS.some(([value]) => value === status)) return;
    if (event.source === "session" || event.source === "academy") {
      const overrideId = event.source === "academy" ? `academy_${event.sourceId}` : event.sourceId;
      await setDoc(doc(personal("calendarOverrides"), overrideId), { status, hidden: false, updatedAt: serverTimestamp() }, { merge: true });
    }
    else await updateDoc(doc(personal("calendarEvents"), event.sourceId), { status, updatedAt: serverTimestamp() });
  }
  async function click(event) {
    const button = event.target.closest("button"); if (!button || pending) return;
    try {
      if (button.dataset.go) {
        if (button.dataset.focusDate) {
          selectedDay = new Date(`${button.dataset.focusDate}T12:00:00`);
          month = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
          render();
        }
        navigate(button.dataset.go); return;
      }
      if (button.hasAttribute("data-month")) { month = new Date(month.getFullYear(), month.getMonth() + Number(button.dataset.month), 1); render(); }
      else if (button.hasAttribute("data-today")) { selectedDay = new Date(); month = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1); render(); }
      else if (button.dataset.date) { selectedDay = new Date(`${button.dataset.date}T12:00:00`); render(); }
      else if (button.hasAttribute("data-add-event")) openEditor();
      else if (button.hasAttribute("data-add-academy-event")) openAcademyEditor();
      else if (button.dataset.editEvent) {
        const item = events.find((eventItem) => eventItem.id === button.dataset.editEvent);
        if (item?.source === "academy") openAcademyEditor(item);
        else if (item?.source === "personal") openEditor(item);
      }
      else if (button.dataset.deleteEvent) {
        const item = events.find((entry) => entry.id === button.dataset.deleteEvent); if (!item) return;
        const deleteShared = item.source === "academy" && member.role === "admin";
        const warning = deleteShared
          ? "Delete this academy event for every role? It will be removed from all members' calendars."
          : item.source === "personal" ? "Delete this personal event? This cannot be undone."
            : "Remove this shared event from your calendar only? It will remain on other members' calendars.";
        if (!confirm(warning)) return;
        pending = true; button.disabled = true;
        if (deleteShared) await deleteDoc(doc(db, "academyCalendarEvents", item.sourceId));
        else if (item.source === "session" || item.source === "academy") {
          const overrideId = item.source === "academy" ? `academy_${item.sourceId}` : item.sourceId;
          await setDoc(doc(personal("calendarOverrides"), overrideId), { hidden: true, status: item.status || "auto", updatedAt: serverTimestamp() }, { merge: true });
        } else await deleteDoc(doc(personal("calendarEvents"), item.sourceId));
      } else if (button.hasAttribute("data-restore")) {
        pending = true; button.disabled = true;
        for (const [id, value] of overrides) if (value.hidden) await updateDoc(doc(personal("calendarOverrides"), id), { hidden: false, updatedAt: serverTimestamp() });
      }
    } catch (error) { toast(error?.code === "permission-denied" ? "Calendar change denied. Deploy the updated Firestore rules." : "Could not save the calendar change. Try again.", "error"); }
    finally { pending = false; if (button.isConnected) button.disabled = false; }
  }
  root.addEventListener("click", click); overview.addEventListener("click", click);
  const onChange = async (event) => {
    const id = event.target.dataset.eventStatus;
    if (!id || pending) return;
    const item = events.find((entry) => entry.id === id); if (!item) return;
    pending = true; event.target.disabled = true;
    try { await changeStatus(item, event.target.value); }
    catch (_) { toast("Could not save status. Check your connection and Firestore rules.", "error"); render(); }
    finally { pending = false; if (event.target.isConnected) event.target.disabled = false; }
  };
  root.addEventListener("change", onChange);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (pending) return;
    const values = new FormData(form), start = asDate(values.get("startsAt")), end = asDate(values.get("endsAt"));
    const title = String(values.get("title") || "").trim();
    const message = form.querySelector("[role=alert]");
    if (!title || !start || !end || end <= start) { message.textContent = "Add a title and an end time later than the start time."; return; }
    pending = true; const submit = form.querySelector("[type=submit]"); submit.disabled = true;
    try {
      const payload = { title, notes: String(values.get("notes") || "").trim(), startsAt: start, endsAt: end, status: values.get("status"), updatedAt: serverTimestamp() };
      const id = String(values.get("id") || "");
      if (id) await updateDoc(doc(personal("calendarEvents"), id), payload);
      else await addDoc(personal("calendarEvents"), { ...payload, createdAt: serverTimestamp() });
      selectedDay = new Date(start); month = new Date(start.getFullYear(), start.getMonth(), 1);
      modal.close(); render(); toast("Calendar event saved.");
    } catch (_) { message.textContent = "Could not save. Check your connection and deploy the included Firestore rules."; }
    finally { pending = false; submit.disabled = false; }
  });

  async function notifyAcademyEvent(eventId, eventData, updated = false) {
    const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
    const recipients = snapshot.docs.filter((item) => item.id !== uid
      && (eventData.audienceRole === "all" || item.data().role === eventData.audienceRole));
    const title = `${updated ? "Updated academy event" : "New academy event"}: ${eventData.title}`.slice(0, 120);
    const message = `${eventData.audienceRole === "all" ? "All roles" : `${eventData.audienceRole} role`} · ${dateTime(eventData.startsAt)}`.slice(0, 1500);
    for (let offset = 0; offset < recipients.length; offset += 3) {
      const batch = writeBatch(db);
      recipients.slice(offset, offset + 3).forEach((recipient) => {
        batch.set(doc(collection(db, "teamMembers", recipient.id, "notifications")), {
          type: "academy_calendar_event", title, message,
          actorUid: uid, actorName: String(member.displayName || "Admin").slice(0, 80),
          eventId, createdAt: serverTimestamp(), read: false
        });
      });
      await batch.commit();
    }
  }

  if (academyForm) academyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (member.role !== "admin" || pending) return;
    const values = new FormData(academyForm);
    const title = String(values.get("title") || "").trim();
    const description = String(values.get("description") || "").trim();
    const audienceRole = String(values.get("audienceRole") || "");
    const startsAt = asDate(values.get("startsAt")), endsAt = asDate(values.get("endsAt"));
    const message = academyForm.querySelector("[role=alert]");
    if (!title || !startsAt || !endsAt || endsAt <= startsAt
      || !["all", "admin", "user", "leaders", "public", "tech", "social", "designers", "content", "event"].includes(audienceRole)) {
      message.textContent = "Add a title, a valid time range, and a target audience.";
      return;
    }
    pending = true;
    const submit = academyForm.querySelector('[type="submit"]');
    submit.disabled = true;
    const id = String(values.get("id") || "");
    try {
      const payload = {
        title, description, audienceRole, startsAt, endsAt, updatedBy: uid, updatedAt: serverTimestamp()
      };
      let eventId = id;
      if (id) {
        await updateDoc(doc(db, "academyCalendarEvents", id), payload);
      } else {
        const created = await addDoc(collection(db, "academyCalendarEvents"), {
          ...payload, createdBy: uid, createdAt: serverTimestamp()
        });
        eventId = created.id;
      }
      let noticeFailed = false;
      try {
        await notifyAcademyEvent(eventId, { ...payload, startsAt }, Boolean(id));
      } catch (error) {
        noticeFailed = true;
        console.warn("Academy event saved, but some inbox notices could not be sent:", error);
      }
      selectedDay = new Date(startsAt);
      month = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
      academyModal.close();
      render();
      toast(noticeFailed
        ? "Event saved, but some inbox notices could not be delivered."
        : id ? "Academy event updated." : "Academy event published to its audience.", noticeFailed ? "error" : "ok");
    } catch (error) {
      message.textContent = error?.code === "permission-denied"
        ? "Only Admins can publish academy events. Deploy the updated Firestore rules."
        : "Could not save this event. Check your connection and Firestore rules.";
    } finally {
      pending = false;
      submit.disabled = false;
    }
  });

  const sessionsBase = collection(db, "nawrasOnlineSessions");
  const sessionQueries = member.role === "admin"
    ? [sessionsBase]
    : [
      query(sessionsBase, where("audienceRole", "in", ["all", member.role]), where("audienceUniversityTag", "in", [...new Set(["", member.universityTag || ""])])),
      query(sessionsBase, where("audienceRole", "==", "targeted"), where("targetMemberUids", "array-contains", uid))
    ];
  sessionQueries.forEach((ref, index) => watch(`sessions ${index + 1}`, ref, (snapshot) => {
    sessionSources.set(index, snapshot.docs.map((item) => ({ ...item.data(), id: item.id })));
    // The former session page already migrates this legacy audience field for admins.
    if (member.role === "admin") snapshot.docs.filter((item) => !Object.prototype.hasOwnProperty.call(item.data(), "audienceUniversityTag")).forEach((item) => {
      updateDoc(item.ref, { audienceUniversityTag: "" }).catch((error) => failure("legacy sessions", error));
    });
  }));
  watch("personal events", personal("calendarEvents"), (snapshot) => {
    manualEvents = snapshot.docs.map((item) => ({ ...item.data(), id: `personal:${item.id}`, sourceId: item.id, source: "personal" })).filter((item) => asDate(item.startsAt));
  });
  const academyEventsBase = collection(db, "academyCalendarEvents");
  watch("academy events", member.role === "admin"
    ? academyEventsBase
    : query(academyEventsBase, where("audienceRole", "in", ["all", member.role])),
  (snapshot) => {
    academyEvents = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => asDate(item.startsAt) && asDate(item.endsAt));
  });
  watch("session preferences", personal("calendarOverrides"), (snapshot) => { overrides = new Map(snapshot.docs.map((item) => [item.id, item.data()])); });
  const clock = window.setInterval(render, 60000);
  render();
  return {
    refreshOverview,
    stop() {
      stopped = true; stops.forEach((stop) => stop()); clearInterval(clock);
      root.removeEventListener("click", click); overview.removeEventListener("click", click); root.removeEventListener("change", onChange);
      modal.close(); modal.remove(); academyModal?.close(); academyModal?.remove(); root.innerHTML = ""; overview.innerHTML = "";
    }
  };
}
