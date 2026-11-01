import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where,
  deleteDoc, setDoc, updateDoc, serverTimestamp, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { isSessionForMember } from "./personal-calendar-core.js";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const TOKEN_ENDPOINT = "https://nawras-online-token.nawrasedu.workers.dev/token";
// Session invite links always use the primary domain, even when the page is opened from nawrasedu.site.
const SESSION_SHARE_ORIGIN = "https://nawrasedu.site.je";
const sessionPageUrl = () => new URL("/nawras-online.html", SESSION_SHARE_ORIGIN);
// NawrasOnline only runs on the primary domain so sign-in, session creation and invite links all share one origin.
const SECONDARY_HOSTS = new Set(["nawrasedu.site", "www.nawrasedu.site"]);
if (SECONDARY_HOSTS.has(window.location.hostname.toLowerCase())) {
  window.location.replace(`${SESSION_SHARE_ORIGIN}${window.location.pathname}${window.location.search}${window.location.hash}`);
  throw new Error("Redirecting NawrasOnline to the primary domain.");
}
const CHAT_TOPIC = "nawras-room-chat-v1";
const REACTIONS = Object.freeze({
  like: { label: "Like", image: "https://i.ibb.co/pph0XSj/like.png" },
  celebrate: { label: "Celebrate", image: "https://i.ibb.co/v4bykbQq/calebrate.png" },
  angry: { label: "Angry", image: "https://i.ibb.co/3mBJsNnj/angry.png" },
  love: { label: "Love", image: "https://i.ibb.co/dwKS1HZV/love.png" },
  laugh: { label: "Laugh", image: "https://i.ibb.co/qLhR0gR5/Laugh.png" },
  think: { label: "Think", image: "https://i.ibb.co/5hx6Tcd6/thinking.png" }
});
const $ = (id) => document.getElementById(id);
document.querySelectorAll('a[href="schedule.html"]').forEach((link) => link.remove());
const GROUPS = ["user", "leaders", "public", "tech", "social", "designers", "content", "event"];
const VALID_ROLES = new Set(["admin", ...GROUPS]);
const UNIVERSITY_TAGS = new Set(["", "AAUP-Jenin", "AAUP-Ramallah", "BZU", "NNU", "PPU", "PTUK"]);
const state = {
  user: null, member: null, sessionsUnsubscribe: null, handsUnsubscribe: null,
  activeSessionUnsubscribe: null, sessions: [], hands: [], activeSession: null, room: null, livekit: null,
  micOn: false, cameraOn: false, screenOn: false, handRaised: false, attachingTracks: new Set(),
  spotlightIdentity: null, voiceHandAlerts: false, handsInitialized: false, participantProfiles: new Map(),
  handSoundedUids: new Set(),
  soundContext: null, roomSoundsEnabled: true, reactionTimers: new Set(), reactionLastSentAt: 0, reactionSenderTimes: new Map(), reactionAnnouncementTimer: null,
  migratingLegacySessions: false,
  targetMembers: [], selectedTargets: new Set(),
  chatUnreadCount: 0, chatNotificationTimer: null,
  miniRoomWindow: null, miniRoomObserver: null,
  attendanceVisit: null,
  linkedSessionId: new URLSearchParams(window.location.search).get("session") || "",
  linkedSessionAttempted: false
};

async function issueRoomToken(payload) {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("Sign in again before joining the video session.");
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "The video service could not issue a room token.");
    error.code = `functions/${data.code || (response.status === 403 ? "permission-denied" : "unavailable")}`;
    throw error;
  }
  return { data };
}

if ($("year")) $("year").textContent = String(new Date().getFullYear());

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function toast(message, type = "ok") {
  const root = $("toastRoot");
  if (!root) return;
  const item = document.createElement("div");
  item.className = `toast${type === "error" ? " error" : ""}`;
  item.textContent = message;
  root.appendChild(item);
  window.setTimeout(() => item.remove(), 4200);
}

function primeRoomSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    state.soundContext ||= new AudioContextClass();
    if (state.soundContext.state === "suspended") {
      void state.soundContext.resume().catch(() => {});
    }
  } catch (error) {
    console.debug("Room sound effects are unavailable:", error);
  }
}

const ROOM_SOUND_CUES = Object.freeze({
  "reaction-like": { wave: "triangle", notes: [[783.99, 0], [1046.5, 0.075]] },
  "reaction-celebrate": { wave: "triangle", notes: [[523.25, 0], [783.99, 0.075], [1046.5, 0.15], [1318.51, 0.225]] },
  "reaction-angry": { wave: "sawtooth", notes: [[392, 0], [311.13, 0.09], [233.08, 0.18]] },
  "reaction-love": { wave: "sine", notes: [[523.25, 0], [659.25, 0.11], [783.99, 0.22]] },
  "reaction-laugh": { wave: "square", notes: [[880, 0], [698.46, 0.08], [880, 0.16], [1046.5, 0.24]] },
  "reaction-think": { wave: "sine", notes: [[587.33, 0], [698.46, 0.16], [783.99, 0.32]] },
  "hand-up": { wave: "triangle", notes: [[587.33, 0], [880, 0.09]] },
  "sound-on": { wave: "sine", notes: [[659.25, 0], [880, 0.08]] },
  "sound-off": { wave: "sine", notes: [[523.25, 0], [392, 0.1]] },
});

async function playRoomSound(cue) {
  if (!state.roomSoundsEnabled) return;
  primeRoomSound();
  const context = state.soundContext;
  if (!context) return;
  try {
    if (context.state === "suspended") await context.resume();
    const start = context.currentTime;
    const pattern = ROOM_SOUND_CUES[cue];
    if (!pattern) return;
    pattern.notes.forEach(([frequency, delay]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + delay;
      oscillator.type = pattern.wave;
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.045, noteStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.17);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.18);
    });
  } catch (error) {
    console.debug("Could not play a room sound effect:", error);
  }
}

function updateRoomSoundButton() {
  const button = $("onlineRoomSoundButton");
  if (!button) return;
  button.setAttribute("aria-pressed", String(state.roomSoundsEnabled));
  button.title = state.roomSoundsEnabled ? "Mute room and reaction sounds" : "Turn on room and reaction sounds";
  const icon = button.querySelector(".material-symbols-outlined");
  const label = button.querySelector("span:last-child");
  if (icon) icon.textContent = state.roomSoundsEnabled ? "volume_up" : "volume_off";
  if (label) label.textContent = state.roomSoundsEnabled ? "Sounds on" : "Sounds off";
}

function toggleRoomSounds() {
  const enabled = !state.roomSoundsEnabled;
  if (!enabled) void playRoomSound("sound-off");
  state.roomSoundsEnabled = enabled;
  updateRoomSoundButton();
  if (enabled) void playRoomSound("sound-on");
}

function setAuthMessage(message, show = true) {
  const panel = $("onlineLoginPanel");
  if (panel) panel.classList.toggle("hidden", !show);
  const messageNode = $("onlineAuthMessage");
  if (messageNode) messageNode.textContent = message;
}

function setHeroCta(isSignedIn = false) {
  const button = $("onlineHeroCta");
  if (!button) return;
  button.href = isSignedIn ? "#onlineSessionsTitle" : "#onlineLoginForm";
  button.innerHTML = isSignedIn
    ? 'View my sessions <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>'
    : 'Sign in to see sessions <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>';
}

function isHost() {
  return ["admin", "leaders"].includes(state.member?.role);
}

function isAdmin() {
  return state.member?.role === "admin";
}

function displayName() {
  return String(state.member?.displayName || state.user?.displayName || state.user?.email?.split("@")[0] || "NAWRAS member");
}

async function startAttendanceVisit(session) {
  if (!state.user || !session?.id || state.attendanceVisit) return;
  const visitRef = doc(collection(db, "nawrasOnlineSessions", session.id, "attendanceVisits"));
  const visit = { ref: visitRef, sessionId: session.id, closing: false };
  state.attendanceVisit = visit;
  try {
    await setDoc(visitRef, {
      uid: state.user.uid,
      displayName: displayName().slice(0, 80),
      email: String(state.user.email || "").slice(0, 254),
      enteredAt: serverTimestamp(),
      leftAt: null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    });
  } catch (error) {
    if (state.attendanceVisit === visit) state.attendanceVisit = null;
    console.error("Could not save NawrasOnline attendance entry:", error);
    toast("The room connected, but attendance tracking could not be saved. Check the deployed Firestore rules.", "error");
  }
}

async function closeAttendanceVisit() {
  const visit = state.attendanceVisit;
  if (!visit) return;
  if (visit.closingPromise) return visit.closingPromise;
  visit.closing = true;
  visit.closingPromise = (async () => {
    try {
      await updateDoc(visit.ref, { leftAt: serverTimestamp() });
      if (state.attendanceVisit === visit) state.attendanceVisit = null;
    } catch (error) {
      visit.closing = false;
      console.warn("Could not save NawrasOnline attendance exit:", error);
    } finally {
      visit.closingPromise = null;
    }
  })();
  return visit.closingPromise;
}

function roomProfilePhotoUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function fillProfileAvatar(container, name, photoURL) {
  if (!container) return;
  const initial = String(name || "N").trim().charAt(0).toUpperCase() || "N";
  const url = roomProfilePhotoUrl(photoURL);
  container.replaceChildren();
  if (!url) {
    container.textContent = initial;
    return;
  }
  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    if (image.parentNode === container) {
      image.remove();
      container.textContent = initial;
    }
  }, { once: true });
  container.appendChild(image);
}

function currentRoomProfile() {
  return {
    uid: state.user?.uid || "",
    displayName: displayName().slice(0, 80),
    photoURL: roomProfilePhotoUrl(state.member?.photoURL || state.user?.photoURL)
  };
}

function dateValue(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const date = dateValue(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Time not set";
}

function roleLabel(role) {
  if (role === "all") return "All team members";
  if (role === "targeted") return "Invited members only";
  return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : "Team";
}

function sessionAccess(session) {
  return isHost() || isSessionForMember(session, state.member);
}

async function notifySessionAudience(sessionId, session, type) {
  const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
  const recipients = snapshot.docs.map((item) => ({ ...item.data(), uid: item.id })).filter((member) => member.active === true
    && member.uid !== state.user?.uid
    && isSessionForMember({ ...session, status: "scheduled" }, member));
  const title = type === "session_cancelled"
    ? `Session cancelled: ${session.title || "Video session"}`
    : `New session: ${session.title || "Video session"}`;
  const message = type === "session_cancelled"
    ? `The session “${session.title || "Video session"}” was cancelled.`
    : `A session for your team is scheduled for ${formatDate(session.startsAt)}. Open the inbox notice to view it.`;
  for (let offset = 0; offset < recipients.length; offset += 3) {
    const batch = writeBatch(db);
    recipients.slice(offset, offset + 3).forEach((recipient) => {
      const notificationRef = doc(collection(db, "teamMembers", recipient.uid, "notifications"));
      batch.set(notificationRef, {
        type, title: title.slice(0, 120), message: message.slice(0, 1500),
        actorUid: state.user.uid, actorName: displayName().slice(0, 80),
        sessionId, createdAt: serverTimestamp(), read: false
      });
    });
    await batch.commit();
  }
  return recipients.length;
}

async function loadSessionTargetMembers() {
  if (!isHost()) return;
  const accountUid = state.user.uid;
  try {
    const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
    if (state.user?.uid !== accountUid) return;
    state.targetMembers = snapshot.docs.map((item) => ({ ...item.data(), uid: item.id }))
      .sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
    renderSessionTargetMembers();
  } catch (_) {
    if ($("onlineTargetMembers")) $("onlineTargetMembers").textContent = "Member search could not be loaded. Refresh and try again.";
  }
}

function renderSessionTargetMembers() {
  const list = $("onlineTargetMembers"); if (!list) return;
  const search = String($("onlineTargetSearch")?.value || "").toLowerCase().trim();
  const matches = state.targetMembers.filter((item) => `${item.displayName || ""} ${item.role || ""} ${item.universityTag || ""} ${item.uid}`.toLowerCase().includes(search));
  list.innerHTML = matches.length ? matches.map((item) => `<label class="online-target-member"><input type="checkbox" value="${escapeHtml(item.uid)}" ${state.selectedTargets.has(item.uid) ? "checked" : ""}><span><strong>${escapeHtml(item.displayName || "Team member")}</strong><small>${escapeHtml(roleLabel(item.role))} · ${escapeHtml(item.universityTag || "No university")}</small></span></label>`).join("") : '<p class="panel-hint">No matching members.</p>';
  if ($("onlineTargetCount")) $("onlineTargetCount").textContent = `${state.selectedTargets.size} invited`;
}
$("onlineTargetSearch")?.addEventListener("input", renderSessionTargetMembers);
$("onlineTargetMembers")?.addEventListener("change", (event) => {
  if (event.target.type !== "checkbox") return;
  if (event.target.checked && state.selectedTargets.size >= 100) {
    event.target.checked = false; return toast("Invite up to 100 individuals per session.", "error");
  }
  if (event.target.checked) state.selectedTargets.add(event.target.value);
  else state.selectedTargets.delete(event.target.value);
  if ($("onlineTargetCount")) $("onlineTargetCount").textContent = `${state.selectedTargets.size} invited`;
});

async function migrateLegacySessionAudiences(sessionDocs) {
  if (!isAdmin() || state.migratingLegacySessions) return;
  const legacyDocs = sessionDocs.filter((item) =>
    !Object.prototype.hasOwnProperty.call(item.data(), "audienceUniversityTag")
  );
  if (!legacyDocs.length) return;

  state.migratingLegacySessions = true;
  try {
    for (let index = 0; index < legacyDocs.length; index += 450) {
      const batch = writeBatch(db);
      legacyDocs.slice(index, index + 450).forEach((item) => {
        batch.update(item.ref, { audienceUniversityTag: "" });
      });
      await batch.commit();
    }
  } catch (error) {
    console.warn("Could not add default university audiences to older sessions:", error);
  } finally {
    state.migratingLegacySessions = false;
  }
}

function setSignedInUI() {
  setHeroCta(true);
  $("onlineMemberPanel")?.classList.remove("hidden");
  $("onlineMemberName").textContent = displayName();
  $("onlineMemberRole").textContent = roleLabel(state.member.role);
  $("onlineHostPanel")?.classList.toggle("hidden", !isHost());
  $("onlineRoomPanel")?.classList.add("hidden");
  $("onlineEndSessionButton")?.classList.toggle("hidden", !isHost());
  updateHandVoiceButton();
  setAuthMessage("", false);
}

function listenForSessions() {
  state.sessionsUnsubscribe?.();
  if (!state.member) return;
  const base = collection(db, "nawrasOnlineSessions");
  const queries = isHost()
    ? [base]
    : [query(
      base,
      where("audienceRole", "in", ["all", state.member.role]),
      where("audienceUniversityTag", "in", [...new Set(["", state.member.universityTag || ""])])
    ), query(base, where("targetMemberUids", "array-contains", state.user.uid))];
  const sources = new Map(), ready = new Set();
  const stops = queries.map((ref, index) => onSnapshot(ref, (snapshot) => {
    if (isAdmin()) void migrateLegacySessionAudiences(snapshot.docs);
    sources.set(index, snapshot.docs.map((item) => ({ ...item.data(), id: item.id })));
    ready.add(index);
    const merged = new Map();
    sources.forEach((items) => items.forEach((item) => merged.set(item.id, item)));
    state.sessions = [...merged.values()]
      .filter((item) => sessionAccess(item) && item.status !== "cancelled")
      .sort((a, b) => (dateValue(a.startsAt)?.getTime() || 0) - (dateValue(b.startsAt)?.getTime() || 0));
    renderSessions();
    if (ready.size === queries.length) void tryJoinLinkedSession(snapshot.metadata.fromCache);
  }, (error) => {
    console.error("Could not load NawrasOnline sessions:", error);
    $("onlineSessionsList").innerHTML = '<div class="empty-state">Sessions could not be loaded. Refresh and sign in again if the issue continues.</div>';
    toast("Could not load sessions. Check the Firestore rules deployment.", "error");
  }));
  state.sessionsUnsubscribe = () => stops.forEach((stop) => stop());
}

function sessionCard(session) {
  const statusLabel = session.status === "live" ? "Live now" : session.status === "ended" ? "Ended" : "Scheduled";
  const statusClass = session.status === "live" ? "is-live" : session.status === "ended" ? "is-ended" : "is-scheduled";
  const canJoin = session.status === "scheduled" || session.status === "live";
  const primaryLabel = isHost() && session.status === "scheduled" ? "Start & join" : "Join session";
  const joinUrl = sessionPageUrl();
  joinUrl.searchParams.set("session", session.id);
  const shareLink = isHost() && canJoin
    ? `<div class="online-session-share">
        <span class="online-session-share-label">Invite link</span>
        <a class="online-session-share-url" href="${escapeHtml(joinUrl.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(joinUrl.toString())}</a>
        <button class="online-session-copy-button" type="button" data-copy-session-link data-session-id="${escapeHtml(session.id)}">Copy link</button>
      </div>`
    : "";
  const managerAction = isHost() && session.status === "scheduled"
    ? `<button class="btn btn-outline btn-compact" type="button" data-session-action="cancel" data-session-id="${escapeHtml(session.id)}">Cancel session</button>`
    : isAdmin() && session.status === "ended"
      ? `<button class="btn btn-danger btn-small" type="button" data-session-action="delete" data-session-id="${escapeHtml(session.id)}">Delete permanently</button>`
    : "";
  return `<article class="online-session-card">
    <div class="online-session-copy">
      <div class="online-session-tags"><span class="online-status ${statusClass}">${statusLabel}</span><span class="online-audience">${escapeHtml(roleLabel(session.audienceRole))}</span><span class="online-audience online-audience-university">${escapeHtml(session.audienceUniversityTag ? `${session.audienceUniversityTag} only` : "All universities")}</span></div>
      <h3>${escapeHtml(session.title || "Video session")}</h3>
      <p class="online-session-description">${escapeHtml(session.description || "Join the room when the session is ready.")}</p>
      <div class="online-session-meta"><span>◷ ${escapeHtml(formatDate(session.startsAt))}</span><span>Created by ${escapeHtml(session.createdByName || "NAWRAS team")}</span></div>
      ${shareLink}
    </div>
    <div class="online-session-actions">
      ${canJoin ? `<button class="btn btn-primary btn-small" type="button" data-session-action="join" data-session-id="${escapeHtml(session.id)}">${primaryLabel}</button>` : ""}
      ${managerAction}
    </div>
  </article>`;
}

function renderSessions() {
  const list = $("onlineSessionsList");
  if (!list) return;
  $("onlineSessionCount").textContent = String(state.sessions.length);
  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state">No sessions are available for your team yet.</div>';
    return;
  }
  list.innerHTML = state.sessions.map(sessionCard).join("");
  list.querySelectorAll("[data-session-action]").forEach((button) => {
    button.addEventListener("click", () => handleSessionAction(button.dataset.sessionAction, button.dataset.sessionId));
  });
  list.querySelectorAll("[data-copy-session-link]").forEach((button) => {
    button.addEventListener("click", () => void copySessionLink(button));
  });
}

async function copySessionLink(button) {
  if (!isHost()) return toast("Only admins and leaders can copy session links.", "error");
  const session = state.sessions.find((item) => item.id === button.dataset.sessionId);
  if (!session || !["scheduled", "live"].includes(session.status)) {
    return toast("This session no longer has an active invite link.", "error");
  }
  const url = sessionPageUrl();
  url.searchParams.set("session", session.id);
  const label = button.textContent;
  try {
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      const field = document.createElement("textarea");
      field.value = url.toString();
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Clipboard access is unavailable.");
    }
    button.textContent = "Copied!";
    toast("Session invite link copied.");
    window.setTimeout(() => {
      if (button.isConnected) button.textContent = label;
    }, 1800);
  } catch (error) {
    console.warn("Could not copy session link:", error);
    toast("Could not copy the link. Select the invite URL and copy it manually.", "error");
  }
}

async function createSession(event) {
  event.preventDefault();
  if (!isHost()) return toast("Only admins and leaders can create sessions.", "error");
  const form = event.currentTarget;
  const values = new FormData(form);
  const title = String(values.get("title") || "").trim();
  const description = String(values.get("description") || "").trim();
  const audienceRole = String(values.get("audienceRole") || "");
  const targetMemberUids = [...state.selectedTargets];
  const selectedUniversity = String(values.get("audienceUniversityTag") || "all");
  const audienceUniversityTag = selectedUniversity === "all" ? "" : selectedUniversity;
  const startsAt = new Date(String(values.get("startsAt") || ""));
  if (title.length < 3 || title.length > 100) return toast("Session names must be 3–100 characters.", "error");
  if (!["all", "targeted", ...GROUPS].includes(audienceRole)) return toast("Choose a valid audience.", "error");
  if (audienceRole === "targeted" && !targetMemberUids.length) return toast("Select at least one invited member.", "error");
  if (!UNIVERSITY_TAGS.has(audienceUniversityTag)) return toast("Choose a valid university audience.", "error");
  if (Number.isNaN(startsAt.getTime())) return toast("Choose a valid start time.", "error");
  const durationMinutes = Number(values.get("durationMinutes") || 60);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) return toast("Choose a duration between 15 and 480 minutes.", "error");
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const sessionRef = doc(collection(db, "nawrasOnlineSessions"));
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60000);
    const sessionData = {
      title, description, audienceRole, audienceUniversityTag, targetMemberUids,
      startsAt: Timestamp.fromDate(startsAt), endsAt: Timestamp.fromDate(endsAt),
      createdBy: state.user.uid, createdByName: displayName(),
      status: "scheduled", createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    batch.set(sessionRef, sessionData);
    await batch.commit();
    let noticeError = null;
    try {
      await notifySessionAudience(sessionRef.id, sessionData, "session_available");
    } catch (error) {
      noticeError = error;
      console.error("Session was created, but audience inbox notices failed:", error);
    }
    form.reset();
    state.selectedTargets.clear();
    renderSessionTargetMembers();
    toast(noticeError
      ? "Session created and calendars will sync, but some inbox notices could not be sent."
      : "Session created. Matching members were notified and their personal calendars will sync automatically.",
      noticeError ? "error" : "ok");
  } catch (error) {
    console.error("Could not create session:", error);
    toast(error?.code === "permission-denied" ? "Session creation was denied by Firestore rules." : "Could not create the session.", "error");
  } finally {
    submit.disabled = false;
  }
}

async function tryJoinLinkedSession(fromCache = false) {
  if (!state.linkedSessionId || state.linkedSessionAttempted || !state.member) return;
  const session = state.sessions.find((item) => item.id === state.linkedSessionId);
  if (!session) {
    if (fromCache) return;
    state.linkedSessionAttempted = true;
    toast("This session is unavailable to your account or has been removed.", "error");
    return;
  }
  state.linkedSessionAttempted = true;
  if (session.status === "ended") {
    toast("This session has ended and can no longer be joined.", "error");
    return;
  }
  if (session.status === "scheduled" && isHost()) {
    try {
      await setSessionStatus(session, "live");
      session.status = "live";
    } catch (error) {
      console.error("Could not start linked session:", error);
      toast("Could not start this session.", "error");
      return;
    }
  }
  await joinSession(session);
}

async function setSessionStatus(session, status) {
  const sessionRef = doc(db, "nawrasOnlineSessions", session.id);
  const batch = writeBatch(db);
  const sessionUpdate = { status, updatedAt: serverTimestamp() };
  if (status === "ended") {
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
    sessionUpdate.endedAt = serverTimestamp();
    sessionUpdate.expiresAt = expiresAt;
  }
  batch.update(sessionRef, sessionUpdate);
  await batch.commit();
}

async function clearSessionHands(sessionId) {
  const hands = await getDocs(collection(db, "nawrasOnlineSessions", sessionId, "hands"));
  for (let index = 0; index < hands.docs.length; index += 450) {
    const batch = writeBatch(db);
    hands.docs.slice(index, index + 450).forEach((hand) => batch.delete(hand.ref));
    await batch.commit();
  }
}

// Clear child documents before the parent: Firestore does not cascade deletes.
async function clearSessionRecords(sessionId, collectionName) {
  const records = await getDocs(collection(db, "nawrasOnlineSessions", sessionId, collectionName));
  for (let index = 0; index < records.docs.length; index += 450) {
    const batch = writeBatch(db);
    records.docs.slice(index, index + 450).forEach((record) => batch.delete(record.ref));
    await batch.commit();
  }
}

const deletingSessionIds = new Set();

async function handleSessionAction(action, sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (action === "delete") {
    if (!isAdmin() || session.status !== "ended" || deletingSessionIds.has(sessionId)) return;
    const confirmed = window.confirm(
      `Permanently delete “${session.title || "Video session"}”, ALL attendance visits and admin notes? Download attendance from the dashboard first if you need a copy. It will also disappear from personal calendars. This cannot be undone.`
    );
    if (!confirmed) return;
    deletingSessionIds.add(sessionId);
    try {
      const sessionRef = doc(db, "nawrasOnlineSessions", session.id);
      const currentSession = await getDoc(sessionRef);
      if (!currentSession.exists() || currentSession.data().status !== "ended") {
        toast("Only an ended session can be permanently deleted. Refresh your sessions and try again.", "error");
        return;
      }
      // Keep the parent until cleanup succeeds so a failed deletion can be retried.
      await clearSessionRecords(session.id, "attendanceVisits");
      await clearSessionRecords(session.id, "attendance");
      await clearSessionHands(session.id);
      const batch = writeBatch(db);
      batch.delete(sessionRef);
      await batch.commit();
      toast("Ended session, attendance records and admin notes deleted.");
    } catch (error) {
      console.error("Could not delete ended session:", error);
      toast("Deletion did not finish. Some records may already be removed. Deploy the updated Firestore rules, then retry Delete permanently to finish cleanup.", "error");
    } finally {
      deletingSessionIds.delete(sessionId);
    }
    return;
  }
  if (action === "cancel") {
    if (!isHost() || !window.confirm(`Cancel “${session.title}”? Members will no longer see it or be able to join.`)) return;
    try {
      await setSessionStatus(session, "cancelled");
      let noticeError = null;
      try { await notifySessionAudience(session.id, session, "session_cancelled"); }
      catch (error) {
        noticeError = error;
        console.error("Session was cancelled, but audience inbox notices failed:", error);
      }
      toast(noticeError ? "Session cancelled, but some inbox notices could not be sent." : "Session cancelled and invited members were notified.",
        noticeError ? "error" : "ok");
    } catch (error) {
      console.error("Could not cancel session:", error);
      toast("Could not cancel this session.", "error");
    }
    return;
  }
  if (action !== "join" || (session.status !== "scheduled" && session.status !== "live")) return;
  if (isHost() && session.status === "scheduled") {
    try {
      await setSessionStatus(session, "live");
    } catch (error) {
      console.error("Could not start session:", error);
      toast("Could not start this session.", "error");
      return;
    }
  }
  await joinSession(session);
}

function setRoomStatus(message, isError = false) {
  const status = $("onlineRoomStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("online-error-text", isError);
}

function updateControlButtons() {
  const set = (id, enabled, onLabel, offLabel, onIcon, offIcon) => {
    const button = $(id);
    if (!button) return;
    button.disabled = !state.room;
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    const label = enabled ? onLabel : offLabel;
    button.setAttribute("aria-label", label);
    button.title = label;
    const icon = button.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = enabled ? onIcon : offIcon;
    const text = button.querySelector(".online-control-label");
    if (text) text.textContent = label;
  };
  set("onlineMicButton", state.micOn, "Mute microphone", "Turn microphone on", "mic", "mic_off");
  set("onlineCameraButton", state.cameraOn, "Turn camera off", "Turn camera on", "videocam", "videocam_off");
  set("onlineShareButton", state.screenOn, "Stop screen sharing", "Share screen", "stop_screen_share", "screen_share");
  set("onlineHandButton", state.handRaised, "Lower hand", "Raise hand", "front_hand", "front_hand");
  document.querySelectorAll("[data-room-reaction], #onlineReactionToggle").forEach((button) => {
    button.disabled = !state.room;
  });
  updateMiniRoomButton();
  syncMiniRoomWindow();
  if (!state.room) setReactionPicker(false);
}

function updateMiniRoomButton() {
  const button = $("onlineMiniRoomButton");
  if (!button) return;
  const supported = Boolean(window.documentPictureInPicture?.requestWindow);
  button.disabled = !state.room;
  button.title = supported
    ? "Open a floating room with live participants and call controls. It stays visible while you switch tabs."
    : "The floating mini-room requires a recent Chrome or Edge desktop browser. Use Full screen in this browser.";
  const label = button.querySelector("span:last-child");
  if (label) label.textContent = supported
    ? (state.miniRoomWindow ? "Mini room open" : "Pop out mini room")
    : "Mini room unavailable";
}

function syncMiniRoomWindow() {
  const miniWindow = state.miniRoomWindow;
  if (!miniWindow || miniWindow.closed) return;
  const miniDoc = miniWindow.document;
  const miniGrid = miniDoc.getElementById("miniVideoGrid");
  if (!miniGrid) return;
  const sourceTiles = [...($("onlineVideoGrid")?.querySelectorAll(".online-video-tile") || [])];
  const existingTiles = new Map([...miniGrid.children].map((tile) => [tile.dataset.identity, tile]));
  sourceTiles.forEach((sourceTile) => {
    const identity = String(sourceTile.dataset.identity || "");
    if (!identity) return;
    let tile = existingTiles.get(identity);
    if (!tile) {
      tile = miniDoc.createElement("article");
      tile.className = "mini-tile";
      tile.dataset.identity = identity;
      const media = miniDoc.createElement("div");
      media.className = "mini-tile-media";
      const avatar = miniDoc.createElement("div");
      avatar.className = "mini-tile-avatar";
      const video = miniDoc.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.setAttribute("aria-label", "Participant video");
      media.append(avatar, video);
      const name = miniDoc.createElement("span");
      name.className = "mini-tile-name";
      tile.append(media, name);
      miniGrid.appendChild(tile);
    }
    existingTiles.delete(identity);
    const sourceVideo = [...sourceTile.querySelectorAll("video")].find((video) => !video.hidden && video.srcObject);
    const miniVideo = tile.querySelector("video");
    if (sourceVideo && miniVideo.srcObject !== sourceVideo.srcObject) {
      miniVideo.srcObject = sourceVideo.srcObject;
      void miniVideo.play().catch(() => {});
    }
    miniVideo.hidden = !sourceVideo;
    const avatar = tile.querySelector(".mini-tile-avatar");
    avatar.hidden = Boolean(sourceVideo);
    const sourceAvatar = sourceTile.querySelector(".online-video-avatar img");
    if (sourceAvatar?.src && avatar.dataset.src !== sourceAvatar.src) {
      avatar.dataset.src = sourceAvatar.src;
      avatar.style.backgroundImage = `url("${sourceAvatar.src.replace(/["\\\n\r]/g, "")}")`;
    } else if (!sourceAvatar?.src) {
      avatar.style.backgroundImage = "";
      avatar.textContent = String(sourceTile.dataset.participantName || "N").trim().charAt(0).toUpperCase();
    }
    tile.querySelector(".mini-tile-name").textContent = sourceTile.dataset.participantName || "Team member";
    tile.classList.toggle("is-speaking", sourceTile.classList.contains("is-speaking"));
    tile.classList.toggle("is-hand-raised", sourceTile.classList.contains("is-hand-raised"));
    Object.keys(REACTIONS).forEach((reaction) => {
      tile.classList.toggle(`online-react-${reaction}`, sourceTile.classList.contains(`online-react-${reaction}`));
    });
  });
  existingTiles.forEach((tile) => tile.remove());
  const empty = miniDoc.getElementById("miniRoomEmpty");
  if (empty) empty.hidden = sourceTiles.length > 0;
  const count = miniDoc.getElementById("miniRoomCount");
  if (count) count.textContent = `${sourceTiles.length} ${sourceTiles.length === 1 ? "person" : "people"}`;
  const setMiniControl = (action, symbol, label, active) => {
    const button = miniDoc.querySelector(`[data-mini-action="${action}"]`);
    if (!button) return;
    button.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${symbol}</span><span class="sr-only">${label}</span>`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("is-on", active);
  };
  setMiniControl("mic", state.micOn ? "mic" : "mic_off", state.micOn ? "Mute microphone" : "Turn microphone on", state.micOn);
  setMiniControl("camera", state.cameraOn ? "videocam" : "videocam_off", state.cameraOn ? "Turn camera off" : "Turn camera on", state.cameraOn);
  setMiniControl("share", state.screenOn ? "stop_screen_share" : "screen_share", state.screenOn ? "Stop screen sharing" : "Share screen", state.screenOn);
  setMiniControl("hand", "front_hand", state.handRaised ? "Lower hand" : "Raise hand", state.handRaised);
}

function miniRoomDocumentMarkup() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NAWRAS EDU mini room</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0">
    <style>
      *{box-sizing:border-box}body{margin:0;padding:12px;background:#0b1725;color:#f3f7fb;font:600 13px/1.4 "DM Sans",system-ui,sans-serif}
      header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}
      header strong{font-size:14px}#miniRoomCount{color:#9fb1c2;font-size:11px}
      #miniVideoGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:calc(100vh - 130px);overflow:auto}
      .mini-tile{position:relative;min-width:0;overflow:hidden;aspect-ratio:16/10;border:1px solid #30465d;border-radius:12px;background:#172b40}
      .mini-tile-media,.mini-tile video,.mini-tile-avatar{position:absolute;inset:0;width:100%;height:100%}
      .mini-tile video{object-fit:cover}.mini-tile-avatar{display:grid;place-items:center;background-position:center;background-size:cover;color:#c8e5f1;font-size:25px}
      .mini-tile-name{position:absolute;right:5px;bottom:5px;left:5px;overflow:hidden;padding:4px 6px;border-radius:6px;background:#08121dcc;color:#fff;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
      .mini-tile.is-speaking{border-color:#63ddff;box-shadow:0 0 0 2px #63ddff88}.mini-tile.is-hand-raised .mini-tile-name{background:#087a3b}
      .mini-tile.online-react-like{animation:mini-like .72s ease-out}.mini-tile.online-react-love{animation:mini-love .82s ease-out}.mini-tile.online-react-laugh{animation:mini-laugh .68s ease-out}.mini-tile.online-react-celebrate{animation:mini-celebrate .9s ease-out}.mini-tile.online-react-angry{animation:mini-angry .65s ease-out}.mini-tile.online-react-think{animation:mini-think .8s ease-out}
      @keyframes mini-like{35%{transform:translateY(-5px) scale(1.035);box-shadow:0 0 0 3px #60c9ff88}100%{transform:none}}
      @keyframes mini-love{35%{transform:scale(1.04);box-shadow:0 0 0 3px #ff6caa99}100%{transform:none}}
      @keyframes mini-laugh{20%,60%{transform:rotate(-1.6deg)}40%,80%{transform:rotate(1.6deg)}100%{transform:none}}
      @keyframes mini-celebrate{30%{transform:translateY(-4px) rotate(1.5deg);box-shadow:0 0 0 3px #ffc85799}65%{transform:translateY(1px) rotate(-1deg)}100%{transform:none}}
      @keyframes mini-angry{15%,45%,75%{transform:translateX(-3px)}30%,60%,90%{transform:translateX(3px)}100%{transform:none}}
      @keyframes mini-think{35%{transform:translateY(-3px) rotate(-1deg);box-shadow:0 0 0 3px #a58cff88}100%{transform:none}}
      @media(prefers-reduced-motion:reduce){.mini-tile.online-react-like,.mini-tile.online-react-love,.mini-tile.online-react-laugh,.mini-tile.online-react-celebrate,.mini-tile.online-react-angry,.mini-tile.online-react-think{animation:none}}
      #miniRoomEmpty{grid-column:1/-1;padding:22px 8px;color:#9fb1c2;text-align:center}#miniRoomEmpty[hidden]{display:none}
      footer{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:10px}
      button{min-width:0;min-height:42px;padding:6px 4px;border:1px solid #354a61;border-radius:9px;background:#172b40;color:#f5f8fb;font:700 10px "DM Sans",sans-serif;cursor:pointer}
      button:hover,button:focus-visible{border-color:#73cce9;outline:2px solid #73cce9;outline-offset:1px}
      button.is-on{background:#176c5a;border-color:#66c6a0}button[data-mini-action=leave]{background:#753942;border-color:#9a5660}
      button .material-symbols-outlined{display:block;width:auto;height:auto;margin:0 auto 2px;font-family:"Material Symbols Outlined";font-size:16px;vertical-align:middle;font-feature-settings:"liga"}
      .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    </style></head><body><header><strong>NAWRAS EDU · Live room</strong><span id="miniRoomCount">0 people</span></header>
    <div id="miniVideoGrid" aria-live="polite"></div><p id="miniRoomEmpty">Waiting for participants’ video…</p>
    <footer aria-label="Call controls"><button type="button" data-mini-action="mic" aria-label="Turn microphone on" title="Turn microphone on" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">mic_off</span><span class="sr-only">Turn microphone on</span></button><button type="button" data-mini-action="camera" aria-label="Turn camera on" title="Turn camera on" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">videocam_off</span><span class="sr-only">Turn camera on</span></button><button type="button" data-mini-action="share" aria-label="Share screen" title="Share screen" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">screen_share</span><span class="sr-only">Share screen</span></button><button type="button" data-mini-action="hand" aria-label="Raise hand" title="Raise hand" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">front_hand</span><span class="sr-only">Raise hand</span></button><button type="button" data-mini-action="chat" aria-label="Open chat" title="Open chat"><span class="material-symbols-outlined" aria-hidden="true">chat</span><span class="sr-only">Open chat</span></button><button type="button" data-mini-action="leave" aria-label="Leave room" title="Leave room"><span class="material-symbols-outlined" aria-hidden="true">logout</span><span class="sr-only">Leave room</span></button></footer></body></html>`;
}

async function openMiniRoom() {
  if (!state.room) return;
  const pipApi = window.documentPictureInPicture;
  if (!pipApi?.requestWindow) {
    toast("Floating mini-room is supported in recent Chrome or Edge desktop browsers. Use Full screen in this browser.", "error");
    return;
  }
  if (state.miniRoomWindow && !state.miniRoomWindow.closed) {
    state.miniRoomWindow.focus();
    return;
  }
  try {
    const miniWindow = await pipApi.requestWindow({ width: 390, height: 500 });
    miniWindow.document.open();
    miniWindow.document.write(miniRoomDocumentMarkup());
    miniWindow.document.close();
    state.miniRoomWindow = miniWindow;
    miniWindow.document.querySelectorAll("[data-mini-action]").forEach((button) => {
      button.addEventListener("click", () => {
        switch (button.dataset.miniAction) {
          case "mic": void toggleMicrophone(); break;
          case "camera": void toggleCamera(); break;
          case "share": void toggleScreenShare(); break;
          case "hand": void toggleHand(); break;
          case "chat": openChatNotification(); break;
          case "leave": void cleanUpRoom(); break;
        }
      });
    });
    miniWindow.addEventListener("pagehide", () => {
      state.miniRoomObserver?.disconnect();
      state.miniRoomObserver = null;
      if (state.miniRoomWindow === miniWindow) state.miniRoomWindow = null;
      updateMiniRoomButton();
    }, { once: true });
    if ("MutationObserver" in window && $("onlineVideoGrid")) {
      state.miniRoomObserver = new MutationObserver(syncMiniRoomWindow);
      state.miniRoomObserver.observe($("onlineVideoGrid"), {
        attributes: true, childList: true, subtree: true,
        attributeFilter: ["class", "hidden", "src"]
      });
    }
    updateMiniRoomButton();
    syncMiniRoomWindow();
  } catch (error) {
    console.warn("Could not open the floating session window:", error);
    toast("The browser blocked the floating mini-room. Try opening it again from the session page.", "error");
  }
}

function setSpotlight(identity) {
  if (!$("onlineVideoGrid")) return;
  state.spotlightIdentity = state.spotlightIdentity === identity ? null : identity;
  updateParticipantFocusUI();
}

function updateParticipantFocusUI() {
  const grid = $("onlineVideoGrid");
  if (!grid) return;
  const tiles = [...grid.querySelectorAll(".online-video-tile")];
  const focusedTile = tiles.find((tile) => tile.dataset.identity === state.spotlightIdentity);
  if (!focusedTile) state.spotlightIdentity = null;
  const focused = Boolean(state.spotlightIdentity);
  grid.classList.toggle("has-spotlight", focused);

  const participantCount = $("onlineParticipantCount");
  if (participantCount) {
    const count = tiles.length;
    participantCount.textContent = `${count} ${count === 1 ? "person" : "people"} in session`;
  }
  $("onlineShowEveryoneButton")?.classList.toggle("hidden", !focused);

  const dock = $("onlineParticipantDock");
  const avatars = $("onlineParticipantAvatars");
  if (dock && avatars) {
    const others = focused ? tiles.filter((tile) => tile !== focusedTile) : [];
    dock.classList.toggle("hidden", others.length === 0);
    dock.setAttribute("aria-hidden", String(others.length === 0));
    avatars.replaceChildren();
    others.forEach((tile) => {
      const identity = tile.dataset.identity;
      const name = tile.dataset.participantName || "Team member";
      const profile = state.participantProfiles.get(identity) || {};
      const imageUrl = profile.photoURL || tile.querySelector(".online-video-avatar img")?.src || "";
      const button = document.createElement("button");
      button.className = "online-participant-avatar";
      button.dataset.identity = identity;
      button.type = "button";
      button.title = `Focus ${name}`;
      button.setAttribute("aria-label", `Focus ${name}`);
      const avatar = document.createElement("span");
      avatar.className = "online-dock-avatar";
      fillProfileAvatar(avatar, name, imageUrl);
      const caption = document.createElement("span");
      caption.className = "online-dock-name";
      caption.textContent = name;
      button.append(avatar, caption);
      button.addEventListener("click", () => setSpotlight(identity));
      avatars.appendChild(button);
    });
  }

  tiles.forEach((tile) => {
    const isFocused = tile.dataset.identity === state.spotlightIdentity;
    tile.classList.toggle("is-spotlight", isFocused);
    const button = tile.querySelector(".online-focus-button");
    if (button) {
      button.setAttribute("aria-pressed", String(isFocused));
      button.textContent = isFocused ? "Show everyone" : "Focus";
      button.setAttribute("aria-label", `${isFocused ? "Show everyone" : "Focus"} ${tile.dataset.participantName || "participant"}`);
    }
  });
}

function appendChatMessage({ name, text, sentAt = Date.now(), own = false, photoURL = "" }) {
  const list = $("onlineChatMessages");
  if (!list) return;
  list.querySelector(".online-chat-empty")?.remove();
  const message = document.createElement("article");
  message.className = `online-chat-message${own ? " is-own" : ""}`;
  const header = document.createElement("div");
  header.className = "online-chat-message-header";
  const avatar = document.createElement("span");
  avatar.className = "online-chat-avatar";
  avatar.setAttribute("aria-hidden", "true");
  fillProfileAvatar(avatar, name, photoURL);
  const sender = document.createElement("strong");
  sender.textContent = own ? "You" : (name || "Team member");
  const time = document.createElement("time");
  const date = new Date(Number(sentAt) || Date.now());
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  const body = document.createElement("p");
  body.textContent = String(text || "").slice(0, 500);
  header.append(avatar, sender, time);
  message.append(header, body);
  list.appendChild(message);
  while (list.children.length > 150) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
  if (!own) showChatNotification({ name, text, photoURL });
}

function hideChatNotification() {
  window.clearTimeout(state.chatNotificationTimer);
  state.chatNotificationTimer = null;
  const preview = $("onlineChatNotification");
  if (preview) preview.hidden = true;
}

function clearChatNotifications() {
  hideChatNotification();
  state.chatUnreadCount = 0;
  [$("onlineChatTab"), $("onlineSidebarToggleButton")].forEach((button) => {
    button?.classList.remove("has-unread-chat");
    button?.removeAttribute("data-unread-count");
  });
  $("onlineChatTab")?.setAttribute("aria-label", "Chat");
  const label = $("onlineRoomPanel")?.classList.contains("is-chat-open") ? "Hide chat" : "Show chat";
  $("onlineSidebarToggleButton")?.setAttribute("aria-label", label);
  $("onlineSidebarToggleButton")?.setAttribute("title", label);
}

function showChatNotification({ name, text, photoURL }) {
  const panel = $("onlineRoomPanel");
  const preview = $("onlineChatNotification");
  if (!panel || !preview || panel.classList.contains("hidden")) return;
  const chatVisible = !$("onlineChatPanel")?.classList.contains("hidden") &&
    (!isRoomFullscreen(panel) || panel.classList.contains("is-chat-open"));
  if (chatVisible && document.visibilityState === "visible") return;
  state.chatUnreadCount = Math.min(state.chatUnreadCount + 1, 999);
  const count = state.chatUnreadCount > 99 ? "99+" : String(state.chatUnreadCount);
  [$("onlineChatTab"), $("onlineSidebarToggleButton")].forEach((button) => {
    button?.classList.add("has-unread-chat");
    button?.setAttribute("data-unread-count", count);
  });
  const unreadLabel = `${state.chatUnreadCount} unread message${state.chatUnreadCount === 1 ? "" : "s"}`;
  $("onlineChatTab")?.setAttribute("aria-label", `Chat, ${unreadLabel}`);
  $("onlineSidebarToggleButton")?.setAttribute("aria-label", `Show chat, ${unreadLabel}`);
  $("onlineSidebarToggleButton")?.setAttribute("title", `Show chat, ${unreadLabel}`);
  $("onlineChatNotificationSender").textContent = String(name || "Team member").slice(0, 80);
  $("onlineChatNotificationText").textContent = String(text || "").slice(0, 500);
  fillProfileAvatar($("onlineChatNotificationAvatar"), name, photoURL);
  window.clearTimeout(state.chatNotificationTimer);
  preview.hidden = false;
  state.chatNotificationTimer = window.setTimeout(() => {
    if (preview.contains(document.activeElement) || preview.matches(":hover")) return;
    hideChatNotification();
  }, 6500);
}

function openChatNotification() {
  const panel = $("onlineRoomPanel");
  if (panel && isRoomFullscreen(panel)) panel.classList.add("is-chat-open");
  switchSidebarTab("chat");
  updateFullscreenButton();
  $("onlineChatInput")?.focus();
}

async function publishRoomData(message) {
  if (!state.room) return false;
  try {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    await state.room.localParticipant.publishData(payload, { reliable: true, topic: CHAT_TOPIC });
    return true;
  } catch (error) {
    console.warn("Could not share room data:", error);
    return false;
  }
}

function setReactionPicker(open, restoreFocus = false) {
  const picker = $("onlineReactionPicker");
  const toggle = $("onlineReactionToggle");
  if (!picker || !toggle) return;
  picker.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-label", open ? "Hide reactions" : "Show reactions");
  toggle.title = open ? "Hide reactions" : "Show reactions";
  if (open) picker.querySelector("[data-room-reaction]:not(:disabled)")?.focus();
  else if (restoreFocus && !toggle.disabled) toggle.focus();
}

function clearRoomReactions() {
  state.reactionTimers.forEach((timer) => window.clearTimeout(timer));
  state.reactionTimers.clear();
  state.reactionSenderTimes.clear();
  state.reactionLastSentAt = 0;
  window.clearTimeout(state.reactionAnnouncementTimer);
  state.reactionAnnouncementTimer = null;
  $("onlineReactionFeed")?.replaceChildren();
  if ($("onlineReactionAnnouncement")) $("onlineReactionAnnouncement").textContent = "";
  setReactionPicker(false);
}

function animateParticipantCard(tile, reaction) {
  if (!tile || !Object.hasOwn(REACTIONS, reaction)) return;
  const classes = Object.keys(REACTIONS).map((name) => `online-react-${name}`);
  tile.classList.remove(...classes);
  void tile.offsetWidth;
  tile.classList.add(`online-react-${reaction}`);
  tile.addEventListener("animationend", (event) => {
    if (event.target === tile) tile.classList.remove(`online-react-${reaction}`);
  }, { once: true });
}

function showRoomReaction(reaction, senderName, senderIdentity) {
  const definition = Object.hasOwn(REACTIONS, reaction) ? REACTIONS[reaction] : null;
  const feed = $("onlineReactionFeed");
  if (!definition || !feed || !senderIdentity) return;
  const now = Date.now();
  if (now - (state.reactionSenderTimes.get(senderIdentity) || 0) < 450) return;
  state.reactionSenderTimes.set(senderIdentity, now);
  const tile = [...($("onlineVideoGrid")?.children || [])].find((item) => item.dataset.identity === senderIdentity);
  void playRoomSound(`reaction-${reaction}`);
  animateParticipantCard(tile, reaction);
  const dockButton = [...($("onlineParticipantAvatars")?.children || [])].find((item) => item.dataset.identity === senderIdentity);
  const visible = (element) => {
    if (!element) return false;
    const r = element.getBoundingClientRect();
    const bounds = feed.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= bounds.top && r.bottom <= bounds.bottom && r.left >= bounds.left && r.right <= bounds.right;
  };
  const dockAvatar = dockButton?.querySelector(".online-dock-avatar");
  const tileAvatar = tile?.querySelector(".online-video-avatar");
  const nameAvatar = tile?.querySelector(".online-name-avatar");
  const hasVideo = Boolean(tile?.querySelector("video"));
  const origin = visible(dockAvatar) ? dockAvatar : (visible(tileAvatar) && !hasVideo ? tileAvatar : nameAvatar);
  // Do not attribute a reaction to another person when its sender is off screen.
  if (!visible(origin)) return;
  const bounds = feed.getBoundingClientRect();
  const rect = origin.getBoundingClientRect();
  const card = document.createElement("div");
  card.className = "online-reaction-burst";
  card.style.setProperty("--reaction-x", `${rect.left + rect.width / 2 - bounds.left}px`);
  card.style.setProperty("--reaction-y", `${rect.top + rect.height / 2 - bounds.top}px`);
  card.style.setProperty("--reaction-rise", `${Math.min(180, Math.max(24, rect.top + rect.height / 2 - bounds.top - 26))}px`);
  card.style.setProperty("--reaction-drift", `${Math.random() * 32 - 16}px`);
  const image = document.createElement("img");
  image.src = definition.image;
  image.alt = "";
  image.referrerPolicy = "no-referrer";
  card.append(image);
  feed.appendChild(card);
  while (feed.children.length > 12) feed.firstElementChild?.remove();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timer = window.setTimeout(() => { card.remove(); state.reactionTimers.delete(timer); }, reduced ? 1100 : 2400);
  state.reactionTimers.add(timer);
  if (!state.reactionAnnouncementTimer) {
    $("onlineReactionAnnouncement").textContent = `${String(senderName || "A team member").slice(0, 80)} reacted with ${definition.label}`;
    state.reactionAnnouncementTimer = window.setTimeout(() => {
      if ($("onlineReactionAnnouncement")) $("onlineReactionAnnouncement").textContent = "";
      state.reactionAnnouncementTimer = null;
    }, 2000);
  }
}

async function sendRoomReaction(reaction) {
  const room = state.room;
  if (!room || !Object.hasOwn(REACTIONS, reaction) || Date.now() - state.reactionLastSentAt < 600) return;
  state.reactionLastSentAt = Date.now();
  setReactionPicker(false, true);
  const profile = currentRoomProfile();
  const sent = await publishRoomData({ type: "reaction", reaction, name: profile.displayName, sentAt: Date.now() });
  if (state.room !== room) return;
  if (!sent) {
    toast("Could not share your reaction. Check your room connection and try again.", "error");
    return;
  }
  showRoomReaction(reaction, profile.displayName, room.localParticipant.identity);
}

function announceControlChange(control, enabled) {
  void publishRoomData({ type: "control-state", control, enabled });
}

async function publishRoomProfile() {
  if (!state.room) return;
  const profile = currentRoomProfile();
  const identity = state.room.localParticipant.identity;
  if (identity) state.participantProfiles.set(identity, profile);
  await publishRoomData({ type: "profile", ...profile });
  if (identity) updateParticipantTileProfile(identity, profile);
}

async function requestRoomProfiles() {
  await publishRoomData({ type: "profile-request" });
  await publishRoomProfile();
}

function resetRoomChat() {
  clearChatNotifications();
  const list = $("onlineChatMessages");
  if (list) list.innerHTML = '<p class="online-chat-empty">Messages appear here while you’re in the room.</p>';
  if ($("onlineChatInput")) $("onlineChatInput").value = "";
  switchSidebarTab("chat");
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!state.room) return toast("Join the room before sending a message.", "error");
  const input = $("onlineChatInput");
  const text = String(input?.value || "").trim().slice(0, 500);
  if (!text) return;
  const submit = $("onlineChatForm")?.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const profile = currentRoomProfile();
    const message = { type: "chat", name: profile.displayName, photoURL: profile.photoURL, text, sentAt: Date.now() };
    const payload = new TextEncoder().encode(JSON.stringify(message));
    await state.room.localParticipant.publishData(payload, { reliable: true, topic: CHAT_TOPIC });
    appendChatMessage({ ...message, own: true });
    input.value = "";
    input.focus();
  } catch (error) {
    console.error("Could not send room chat message:", error);
    toast("Could not send the message. Check your room connection and try again.", "error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

function switchSidebarTab(tab) {
  const chatActive = tab === "chat";
  $("onlineChatTab")?.classList.toggle("is-active", chatActive);
  $("onlineHandsTab")?.classList.toggle("is-active", !chatActive);
  $("onlineChatTab")?.setAttribute("aria-selected", String(chatActive));
  $("onlineHandsTab")?.setAttribute("aria-selected", String(!chatActive));
  $("onlineChatPanel")?.classList.toggle("hidden", !chatActive);
  $("onlineHandsPanel")?.classList.toggle("hidden", chatActive);
  if ($("onlineHandsPanel")) $("onlineHandsPanel").hidden = chatActive;
  if (chatActive) clearChatNotifications();
}

function updateHandVoiceButton() {
  const button = $("onlineHandVoiceButton");
  if (!button) return;
  button.classList.toggle("hidden", !isHost());
  button.setAttribute("aria-pressed", String(state.voiceHandAlerts));
  button.innerHTML = state.voiceHandAlerts
    ? '<span class="material-symbols-outlined" aria-hidden="true">volume_up</span> Arabic alerts on'
    : '<span class="material-symbols-outlined" aria-hidden="true">volume_off</span> Turn on Arabic hand alerts';
}

function speakArabicRoomAlert(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ar-SA";
  utterance.rate = 0.88;
  utterance.pitch = 1;
  utterance.volume = 1;
  const arabicVoices = window.speechSynthesis.getVoices()
    .filter((voice) => /^ar([_-]|$)/i.test(voice.lang || ""));
  const voice = arabicVoices.find((item) => /^ar[-_]sa$/i.test(item.lang || "")) || arabicVoices[0];
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

function toggleHandVoiceAlerts() {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    toast("Spoken hand alerts aren’t supported in this browser.", "error");
    return;
  }
  state.voiceHandAlerts = !state.voiceHandAlerts;
  if (state.voiceHandAlerts) {
    speakArabicRoomAlert("تم تفعيل التنبيه الصوتي لرفع الأيدي.");
  } else {
    window.speechSynthesis.cancel();
  }
  updateHandVoiceButton();
}

function speakNewHands(hands, previousIds) {
  if (!state.voiceHandAlerts || !isHost() || !("speechSynthesis" in window)) return;
  hands
    .filter((hand) => !previousIds.has(hand.uid) && hand.uid !== state.user?.uid)
    .forEach((hand) => {
      const name = String(hand.displayName || "").trim();
      speakArabicRoomAlert(name ? `تم رفع يد ${name}.` : "تم رفع يد أحد الأعضاء.");
    });
}

function isRoomFullscreen(roomPanel = $("onlineRoomPanel")) {
  return Boolean(roomPanel && (
    document.fullscreenElement === roomPanel ||
    roomPanel.classList.contains("is-mobile-fullscreen")
  ));
}

function updateFullscreenButton() {
  const roomPanel = $("onlineRoomPanel");
  const button = $("onlineFullscreenButton");
  if (!button || !roomPanel) return;
  const active = isRoomFullscreen(roomPanel);
  const chatOpen = active && roomPanel.classList.contains("is-chat-open");
  button.textContent = active ? "Exit focus" : "Full screen";
  button.setAttribute("aria-label", active ? "Exit focus mode" : "Enter full screen focus mode");
  button.setAttribute("aria-pressed", String(active));
  const sidebarButton = $("onlineSidebarToggleButton");
  sidebarButton?.classList.toggle("hidden", !active);
  sidebarButton?.setAttribute("aria-expanded", String(chatOpen));
  if (sidebarButton) {
    const label = chatOpen ? "Hide chat" : "Show chat";
    sidebarButton.setAttribute("aria-label", label);
    sidebarButton.title = label;
    const labelNode = sidebarButton.querySelector(".online-topbar-icon-label");
    if (labelNode) labelNode.textContent = label;
  }
  document.body?.classList.toggle("online-fullscreen-active", active);
  if (!active) roomPanel.classList.remove("is-chat-open");
  if (!active && !$("onlineChatPanel")?.classList.contains("hidden")) clearChatNotifications();
}

function enterMobileFullscreen() {
  const roomPanel = $("onlineRoomPanel");
  if (!roomPanel) return;
  roomPanel.classList.add("is-mobile-fullscreen");
  roomPanel.classList.remove("is-chat-open");
  updateFullscreenButton();
}

function exitMobileFullscreen() {
  const roomPanel = $("onlineRoomPanel");
  if (!roomPanel) return;
  roomPanel.classList.remove("is-mobile-fullscreen", "is-chat-open");
  updateFullscreenButton();
}

async function toggleFullscreen() {
  const roomPanel = $("onlineRoomPanel");
  if (!roomPanel) return;
  if (document.fullscreenElement === roomPanel) {
    try { await document.exitFullscreen(); }
    catch (error) { console.warn("Could not exit browser fullscreen:", error); }
    return;
  }
  if (roomPanel.classList.contains("is-mobile-fullscreen")) {
    exitMobileFullscreen();
    return;
  }
  if (typeof roomPanel.requestFullscreen !== "function" || document.fullscreenEnabled === false) {
    enterMobileFullscreen();
    return;
  }
  try {
    await roomPanel.requestFullscreen();
  } catch (error) {
    console.info("Using the phone-friendly fullscreen layout:", error);
    enterMobileFullscreen();
  }
}

function toggleFullscreenSidebar() {
  const roomPanel = $("onlineRoomPanel");
  if (!roomPanel || !isRoomFullscreen(roomPanel)) return;
  const opening = !roomPanel.classList.contains("is-chat-open");
  roomPanel.classList.toggle("is-chat-open", opening);
  if (opening) switchSidebarTab("chat");
  updateFullscreenButton();
}

function handleRoomFullscreenEscape(event) {
  const roomPanel = $("onlineRoomPanel");
  if (event.key === "Escape" && $("onlineChatNotification")?.hidden === false) {
    hideChatNotification();
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && $("onlineReactionPicker")?.hidden === false) {
    setReactionPicker(false, true);
    event.preventDefault();
    return;
  }
  if (event.key !== "Escape" || !roomPanel?.classList.contains("is-mobile-fullscreen")) return;
  if (roomPanel.classList.contains("is-chat-open")) roomPanel.classList.remove("is-chat-open");
  else roomPanel.classList.remove("is-mobile-fullscreen");
  updateFullscreenButton();
}

function ensureParticipantTile(participant) {
  const grid = $("onlineVideoGrid");
  if (!grid) return null;
  const existing = [...grid.children].find((child) => child.dataset.identity === participant.identity);
  if (existing) return existing;
  const profile = state.participantProfiles.get(participant.identity) || {};
  const name = profile.displayName || participant.name || participant.identity || "Team member";
  const tile = document.createElement("article");
  tile.className = "online-video-tile";
  tile.dataset.identity = participant.identity;
  tile.dataset.participantName = name;
  const media = document.createElement("div");
  media.className = "online-tile-media";
  const avatar = document.createElement("span");
  avatar.className = "online-video-avatar";
  fillProfileAvatar(avatar, name, profile.photoURL);
  const label = document.createElement("span");
  label.className = "online-video-name";
  const nameAvatar = document.createElement("span");
  nameAvatar.className = "online-name-avatar";
  nameAvatar.setAttribute("aria-hidden", "true");
  fillProfileAvatar(nameAvatar, name, profile.photoURL);
  const nameText = document.createElement("span");
  nameText.className = "online-name-text";
  nameText.textContent = name;
  label.title = name;
  label.append(nameAvatar, nameText);
  const handBadge = document.createElement("span");
  handBadge.className = "online-tile-hand-badge";
  handBadge.hidden = true;
  handBadge.setAttribute("aria-hidden", "true");
  handBadge.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">front_hand</span><span class="sr-only">Hand raised</span>';
  const focusButton = document.createElement("button");
  focusButton.className = "online-focus-button";
  focusButton.type = "button";
  focusButton.textContent = "Focus";
  focusButton.setAttribute("aria-pressed", "false");
  focusButton.setAttribute("aria-label", `Focus ${name}`);
  focusButton.addEventListener("click", () => setSpotlight(participant.identity));
  media.append(avatar);
  tile.append(media, label, handBadge, focusButton);
  grid.appendChild(tile);
  updateParticipantFocusUI();
  updateRaisedHandTiles();
  return tile;
}

function updateRaisedHandTiles() {
  const raisedIds = new Set(state.hands.map((hand) => String(hand.uid || "")));
  $("onlineVideoGrid")?.querySelectorAll(".online-video-tile").forEach((tile) => {
    const identity = String(tile.dataset.identity || "");
    const profile = state.participantProfiles.get(identity) || {};
    const raised = raisedIds.has(identity) || (profile.uid && raisedIds.has(String(profile.uid)));
    tile.classList.toggle("is-hand-raised", Boolean(raised));
    const badge = tile.querySelector(".online-tile-hand-badge");
    if (badge) {
      badge.hidden = !raised;
      badge.setAttribute("aria-hidden", String(!raised));
    }
  });
}

function updateParticipantTileProfile(identity, profile) {
  const tile = [...($("onlineVideoGrid")?.children || [])].find((child) => child.dataset.identity === identity);
  if (!tile) return;
  const name = String(profile.displayName || tile.dataset.participantName || "Team member").slice(0, 80);
  tile.dataset.participantName = name;
  const label = tile.querySelector(".online-video-name");
  if (label) {
    const nameText = label.querySelector(".online-name-text");
    if (nameText) nameText.textContent = name;
    label.title = name;
    fillProfileAvatar(label.querySelector(".online-name-avatar"), name, profile.photoURL);
  }
  const focusButton = tile.querySelector(".online-focus-button");
  if (focusButton) focusButton.setAttribute("aria-label", `Focus ${name}`);
  fillProfileAvatar(tile.querySelector(".online-video-avatar"), name, profile.photoURL);
  updateParticipantFocusUI();
  updateRaisedHandTiles();
}

function refreshParticipantVideo(participant) {
  const tile = [...($("onlineVideoGrid")?.children || [])].find(child => child.dataset.identity === participant?.identity);
  if (!tile) return;
  let visible = false;
  tile.querySelectorAll("video").forEach(video => {
    let muted = video.dataset.muted === "true";
    participant.trackPublications?.forEach(publication => {
      if (publication.trackSid === video.dataset.publicationSid) {
        muted = Boolean(publication.isMuted || publication.track?.isMuted || publication.track?.mediaStreamTrack?.readyState === "ended");
      }
    });
    video.hidden = muted;
    if (!muted) visible = true;
  });
  tile.classList.toggle("has-video", visible);
}

function attachTrack(track, participant, publication) {
  if (!track || !participant) return;
  const localParticipant = state.room?.localParticipant;
  const isLocalParticipant = participant === localParticipant ||
    (localParticipant?.identity && participant.identity === localParticipant.identity);
  if (track.kind === state.livekit?.Track.Kind.Audio && isLocalParticipant) return;
  const trackKey = `${participant.identity}:${track.sid || track.mediaStreamTrack?.id || track.kind}`;
  if (state.attachingTracks.has(trackKey)) return;
  state.attachingTracks.add(trackKey);
  try {
    if (track.kind === state.livekit.Track.Kind.Audio) {
      const audio = track.attach();
      audio.autoplay = true;
      audio.dataset.trackKey = trackKey;
      $("onlineAudioShelf")?.appendChild(audio);
      return;
    }
    const tile = ensureParticipantTile(participant);
    const media = tile?.querySelector(".online-tile-media");
    if (!media || media.querySelector(`[data-track-key="${CSS.escape(trackKey)}"]`)) return;
    const video = track.attach();
    video.classList.add("online-track-video");
    video.dataset.trackKey = trackKey;
    video.dataset.publicationSid = publication?.trackSid || track.sid || "";
    video.dataset.muted = String(Boolean(publication?.isMuted || track.isMuted || track.mediaStreamTrack?.readyState === "ended"));
    video.playsInline = true;
    video.autoplay = true;
    if (publication?.source === state.livekit.Track.Source.ScreenShare) video.classList.add("is-screen-share");
    media.appendChild(video);
    refreshParticipantVideo(participant);
    track.mediaStreamTrack?.addEventListener("ended", () => detachTrack(track, participant, publication), { once: true });
  } catch (error) {
    state.attachingTracks.delete(trackKey);
    console.warn("Could not attach a room track:", error);
  }
}

function detachTrack(track, participant, publication) {
  const trackKey = track ? `${participant?.identity || ""}:${track.sid || track.mediaStreamTrack?.id || track.kind}` : "";
  track?.detach().forEach(element => element.remove());
  state.attachingTracks.delete(trackKey);
  const tile = [...($("onlineVideoGrid")?.children || [])].find(child => child.dataset.identity === participant?.identity);
  tile?.querySelectorAll("video").forEach(video => {
    if ((trackKey && video.dataset.trackKey === trackKey) || (publication?.trackSid && video.dataset.publicationSid === publication.trackSid)) {
      state.attachingTracks.delete(video.dataset.trackKey);
      video.remove();
    }
  });
  refreshParticipantVideo(participant);
}

function syncParticipant(participant) {
  ensureParticipantTile(participant);
  participant.trackPublications?.forEach((publication) => {
    if (publication.track) attachTrack(publication.track, participant, publication);
  });
}

function updateSpeakingIndicators(speakers) {
  const activeIdentities = new Set((speakers || []).map((participant) => participant.identity));
  $("onlineVideoGrid")?.querySelectorAll(".online-video-tile").forEach((tile) => {
    const speaking = activeIdentities.has(tile.dataset.identity);
    tile.classList.toggle("is-speaking", speaking);
    tile.querySelector(".online-video-name")?.classList.toggle("is-speaking", speaking);
  });
}

function removeParticipant(participant) {
  const tile = [...$("onlineVideoGrid").children].find((child) => child.dataset.identity === participant.identity);
  tile?.remove();
  $("onlineAudioShelf")?.querySelectorAll("audio").forEach((audio) => {
    if (audio.dataset.trackKey?.startsWith(`${participant.identity}:`)) audio.remove();
  });
  for (const key of state.attachingTracks) if (key.startsWith(`${participant.identity}:`)) state.attachingTracks.delete(key);
  state.participantProfiles.delete(participant.identity);
  if (state.spotlightIdentity === participant.identity) setSpotlight(participant.identity);
  else updateParticipantFocusUI();
}

function installRoomEvents(room, RoomEvent) {
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => attachTrack(track, participant, publication));
  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => detachTrack(track, participant, publication));
  room.on(RoomEvent.TrackUnpublished, (publication, participant) => detachTrack(publication.track, participant, publication));
  const updateTrackVisibility = (publication, participant) => {
    if (publication.track) attachTrack(publication.track, participant, publication);
    refreshParticipantVideo(participant);
  };
  room.on(RoomEvent.TrackMuted, updateTrackVisibility);
  room.on(RoomEvent.TrackUnmuted, updateTrackVisibility);
  room.on(RoomEvent.ParticipantConnected, (participant) => syncParticipant(participant));
  room.on(RoomEvent.ParticipantDisconnected, removeParticipant);
  room.on(RoomEvent.ActiveSpeakersChanged, updateSpeakingIndicators);
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic && topic !== CHAT_TOPIC) return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload));
      if (participant?.identity === room.localParticipant.identity) return;
      if (message.type === "profile-request") {
        void publishRoomProfile();
        return;
      }
      if (message.type === "profile") {
        if (!participant?.identity) return;
        const profile = {
          uid: String(message.uid || "").slice(0, 128),
          displayName: String(message.displayName || participant.name || "Team member").slice(0, 80),
          photoURL: roomProfilePhotoUrl(message.photoURL)
        };
        state.participantProfiles.set(participant.identity, profile);
        updateParticipantTileProfile(participant.identity, profile);
        return;
      }
      if (message.type === "control-state") {
        return;
      }
      if (message.type === "reaction") {
        if (!participant?.identity || !Object.hasOwn(REACTIONS, message.reaction)) return;
        const profile = participant?.identity ? state.participantProfiles.get(participant.identity) : null;
        showRoomReaction(
          message.reaction,
          profile?.displayName || participant?.name || message.name || "A team member",
          participant.identity
        );
        return;
      }
      if (message.type !== "chat" || typeof message.text !== "string" || !message.text.trim()) return;
      const profile = participant?.identity ? state.participantProfiles.get(participant.identity) : null;
      appendChatMessage({
        name: profile?.displayName || participant?.name || message.name || "Team member",
        text: message.text.slice(0, 500),
        sentAt: message.sentAt,
        own: false,
        photoURL: profile?.photoURL || roomProfilePhotoUrl(message.photoURL)
      });
    } catch (error) {
      console.warn("Ignored an invalid room chat message:", error);
    }
  });
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    if (publication.track) attachTrack(publication.track, room.localParticipant, publication);
  });
  room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
    detachTrack(publication.track, room.localParticipant, publication);
    if (publication.source === state.livekit.Track.Source.ScreenShare) {
      state.screenOn = false;
      updateControlButtons();
    }
  });
  room.on(RoomEvent.Disconnected, () => {
    void closeAttendanceVisit();
    if (state.room === room && $("onlineRoomPanel")?.classList.contains("hidden") === false) {
      setRoomStatus("The room connection ended. Leave and rejoin if you were disconnected unexpectedly.", true);
    }
  });
}

async function joinSession(session) {
  if (!state.user || !state.member) return toast("Sign in with an active team account first.", "error");
  if (!sessionAccess(session)) return toast("This session is for another team.", "error");
  primeRoomSound();
  clearRoomReactions();
  state.activeSession = session;
  state.spotlightIdentity = null;
  state.voiceHandAlerts = false;
  state.handsInitialized = false;
  state.participantProfiles.clear();
  updateHandVoiceButton();
  $("onlineRoomPanel").classList.remove("hidden");
  enterMobileFullscreen();
  $("onlineMemberPanel").classList.add("hidden");
  $("onlineRoomTitle").textContent = session.title || "NAWRAS EDU session";
  $("onlineVideoGrid").replaceChildren();
  $("onlineVideoGrid").classList.remove("has-spotlight");
  updateParticipantFocusUI();
  $("onlineAudioShelf").replaceChildren();
  resetRoomChat();
  $("onlineHandsList").innerHTML = '<p class="online-empty-hands">Loading hands…</p>';
  $("onlineRoomPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  setRoomStatus("Connecting securely to the video room…");
  updateControlButtons();
  try {
    const result = await issueRoomToken({ sessionId: session.id });
    const { serverUrl, accessToken } = result.data || {};
    if (!serverUrl || !accessToken) throw new Error("The video server returned an incomplete room token.");
    const livekit = await import("https://cdn.jsdelivr.net/npm/livekit-client@2.15.0/dist/livekit-client.esm.mjs");
    state.livekit = livekit;
    const room = new livekit.Room({ adaptiveStream: true, dynacast: true });
    state.room = room;
    installRoomEvents(room, livekit.RoomEvent);
    await room.connect(serverUrl, accessToken);
    await startAttendanceVisit(session);
    setRoomStatus("Connected. Your microphone and camera are off until you turn them on.");
    $("onlineMicButton").disabled = false;
    $("onlineCameraButton").disabled = false;
    $("onlineShareButton").disabled = false;
    $("onlineHandButton").disabled = false;
    updateControlButtons();
    syncParticipant(room.localParticipant);
    room.remoteParticipants.forEach(syncParticipant);
    void requestRoomProfiles();
    room.startAudio().catch(() => setRoomStatus("Connected. Tap the page once to allow audio playback."));
    listenForHands(session.id);
    state.activeSessionUnsubscribe?.();
    state.activeSessionUnsubscribe = onSnapshot(doc(db, "nawrasOnlineSessions", session.id), (snapshot) => {
      if (!snapshot.exists() || ["ended", "cancelled"].includes(snapshot.data().status)) {
        toast("This session has ended.");
        cleanUpRoom();
      }
    }, (error) => console.error("Session status listener failed:", error));
  } catch (error) {
    console.error("Could not join NawrasOnline:", error);
    await cleanUpRoom(false);
    $("onlineMemberPanel").classList.remove("hidden");
    $("onlineRoomPanel").classList.add("hidden");
    if (error?.code === "functions/permission-denied" || error?.code === "permission-denied") {
      toast("Your account cannot join this session.", "error");
    } else if (error?.code === "functions/unavailable" || error?.code === "functions/internal") {
      toast("Video service is not configured or is temporarily unavailable.", "error");
    } else {
      toast(error?.message || "Could not connect to the video room.", "error");
    }
  }
}

async function cleanUpRoom(showSessions = true) {
  state.miniRoomObserver?.disconnect();
  state.miniRoomObserver = null;
  if (state.miniRoomWindow && !state.miniRoomWindow.closed) {
    try { state.miniRoomWindow.close(); } catch (error) { console.warn("Could not close floating mini-room:", error); }
  }
  state.miniRoomWindow = null;
  updateMiniRoomButton();
  await closeAttendanceVisit();
  state.handsUnsubscribe?.();
  state.handsUnsubscribe = null;
  state.activeSessionUnsubscribe?.();
  state.activeSessionUnsubscribe = null;
  if (state.room) {
    try { await state.room.disconnect(); } catch (error) { console.warn("Room disconnect warning:", error); }
  }
  const roomPanel = $("onlineRoomPanel");
  if (document.fullscreenElement === roomPanel && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch (error) { console.warn("Could not exit fullscreen while leaving:", error); }
  }
  roomPanel?.classList.remove("is-mobile-fullscreen", "is-chat-open");
  updateFullscreenButton();
  state.room = null;
  state.livekit = null;
  state.attachingTracks.clear();
  state.micOn = false;
  state.cameraOn = false;
  state.screenOn = false;
  state.handRaised = false;
  state.hands = [];
  state.handsInitialized = false;
  state.handSoundedUids.clear();
  state.spotlightIdentity = null;
  state.voiceHandAlerts = false;
  state.participantProfiles.clear();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  $("onlineVideoGrid")?.replaceChildren();
  $("onlineVideoGrid")?.classList.remove("has-spotlight");
  clearRoomReactions();
  updateParticipantFocusUI();
  $("onlineAudioShelf")?.replaceChildren();
  resetRoomChat();
  updateHandVoiceButton();
  $("onlineRoomPanel")?.classList.add("hidden");
  if (showSessions && state.member) $("onlineMemberPanel")?.classList.remove("hidden");
  updateControlButtons();
}

function listenForHands(sessionId) {
  state.handsUnsubscribe?.();
  state.handsUnsubscribe = onSnapshot(collection(db, "nawrasOnlineSessions", sessionId, "hands"), (snapshot) => {
    const previousIds = new Set(state.hands.map((hand) => hand.uid));
    const nextHands = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }));
    if (state.handsInitialized) {
      const newHands = nextHands.filter((hand) => !previousIds.has(hand.uid));
      if (newHands.some((hand) => !state.handSoundedUids.has(hand.uid))) void playRoomSound("hand-up");
      newHands.forEach((hand) => state.handSoundedUids.delete(hand.uid));
      speakNewHands(nextHands, previousIds);
    }
    state.hands = nextHands;
    state.handsInitialized = true;
    state.handRaised = state.hands.some((hand) => hand.uid === state.user?.uid);
    updateControlButtons();
    updateRaisedHandTiles();
    renderHands();
  }, (error) => {
    console.error("Could not load raised hands:", error);
    $("onlineHandsList").innerHTML = '<p class="online-empty-hands">The hand queue is unavailable.</p>';
  });
}

function renderHands() {
  const list = $("onlineHandsList");
  if (!list) return;
  $("onlineHandsCount").textContent = String(state.hands.length);
  updateRaisedHandTiles();
  if (!state.hands.length) {
    list.innerHTML = '<p class="online-empty-hands">No hands raised yet.</p>';
    return;
  }
  list.innerHTML = state.hands.map((hand) => `<div class="online-hand-row"><span class="online-hand-icon material-symbols-outlined" aria-hidden="true">front_hand</span><span>${escapeHtml(hand.displayName || "Team member")}</span>${(isHost() || hand.uid === state.user?.uid) ? `<button class="text-button" type="button" data-lower-hand="${escapeHtml(hand.uid)}" aria-label="Lower ${escapeHtml(hand.displayName || "member")}’s hand">Lower</button>` : ""}</div>`).join("");
  list.querySelectorAll("[data-lower-hand]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await deleteDoc(doc(db, "nawrasOnlineSessions", state.activeSession.id, "hands", button.dataset.lowerHand));
      } catch (error) {
        console.error("Could not lower hand:", error);
        toast("Could not update the raised-hand queue.", "error");
      }
    });
  });
}

async function toggleHand() {
  if (!state.room || !state.activeSession) return;
  const handRef = doc(db, "nawrasOnlineSessions", state.activeSession.id, "hands", state.user.uid);
  try {
    if (state.handRaised) {
      await deleteDoc(handRef);
    } else {
      const uid = state.user.uid;
      state.handSoundedUids.add(uid);
      try {
        await setDoc(handRef, { uid, displayName: displayName(), raisedAt: serverTimestamp() });
        void playRoomSound("hand-up");
      } catch (error) {
        state.handSoundedUids.delete(uid);
        throw error;
      }
    }
  } catch (error) {
    console.error("Could not update raised hand:", error);
    toast("Could not update your raised hand.", "error");
  }
}

async function endSessionFromRoom() {
  if (!isHost() || !state.activeSession || !state.room) return;
  const confirmed = window.confirm("End this video session for everyone?");
  if (!confirmed) return;
  try {
    await setSessionStatus(state.activeSession, "ended");
    try {
      await clearSessionHands(state.activeSession.id);
    } catch (cleanupError) {
      console.warn("Could not clear raised hands from ended session:", cleanupError);
    }
    toast("Session ended.");
    await cleanUpRoom();
  } catch (error) {
    console.error("Could not end the session:", error);
    toast("Could not end this session.", "error");
  }
}

async function toggleMicrophone() {
  if (!state.room) return;
  try {
    state.micOn = !state.micOn;
    await state.room.localParticipant.setMicrophoneEnabled(state.micOn, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    updateControlButtons();
    announceControlChange("microphone", state.micOn);
  } catch (error) {
    state.micOn = false;
    updateControlButtons();
    toast("Microphone access failed. Check browser permissions and try again.", "error");
  }
}

async function toggleCamera() {
  if (!state.room) return;
  try {
    state.cameraOn = !state.cameraOn;
    await state.room.localParticipant.setCameraEnabled(state.cameraOn);
    updateControlButtons();
    announceControlChange("camera", state.cameraOn);
  } catch (error) {
    state.cameraOn = false;
    updateControlButtons();
    toast("Camera access failed. Check browser permissions and try again.", "error");
  }
}

async function toggleScreenShare() {
  if (!state.room) return;
  const enabling = !state.screenOn;
  if (enabling && typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    toast("This browser does not support phone screen capture from a webpage. Update your browser or try a browser that offers screen sharing.", "error");
    return;
  }
  try {
    state.screenOn = enabling;
    await state.room.localParticipant.setScreenShareEnabled(state.screenOn);
    updateControlButtons();
    announceControlChange("screen", state.screenOn);
  } catch (error) {
    state.screenOn = false;
    updateControlButtons();
    if (error?.name === "AbortError") return;
    toast(error?.name === "NotAllowedError"
      ? "Screen sharing was blocked. Allow the browser’s screen-share prompt and try again."
      : "Screen sharing could not start. Your phone browser may not support sharing from webpages.", "error");
  }
}

function setupMenu() {
  const toggle = $("menuToggle");
  const nav = $("primaryNav");
  toggle?.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    nav?.classList.toggle("is-open", !open);
  });
}

$("onlineLoginForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("onlineEmail").value.trim(), $("onlinePassword").value);
  } catch (error) {
    console.error("NawrasOnline sign-in failed:", error);
    setAuthMessage(error?.code === "auth/invalid-credential" ? "Email or password is incorrect." : "Could not sign in. Check your details and try again.");
  } finally {
    button.disabled = false;
  }
});

$("onlineLogoutButton")?.addEventListener("click", async () => {
  await cleanUpRoom(false);
  await signOut(auth);
});
$("onlineCreateForm")?.addEventListener("submit", createSession);
$("onlineLeaveButton")?.addEventListener("click", () => cleanUpRoom());
$("onlineShowEveryoneButton")?.addEventListener("click", () => {
  if (state.spotlightIdentity) setSpotlight(state.spotlightIdentity);
});
$("onlineMicButton")?.addEventListener("click", toggleMicrophone);
$("onlineCameraButton")?.addEventListener("click", toggleCamera);
$("onlineShareButton")?.addEventListener("click", toggleScreenShare);
$("onlineHandButton")?.addEventListener("click", toggleHand);
document.querySelectorAll("[data-room-reaction]").forEach((button) => {
  button.addEventListener("click", () => sendRoomReaction(button.dataset.roomReaction));
});
$("onlineReactionToggle")?.addEventListener("click", () => setReactionPicker($("onlineReactionPicker")?.hidden === true));
$("onlineReactionClose")?.addEventListener("click", () => setReactionPicker(false, true));
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest?.("#onlineReactionPicker, #onlineReactionToggle")) setReactionPicker(false);
});
document.addEventListener("focusin", (event) => {
  if (!event.target.closest?.("#onlineReactionPicker, #onlineReactionToggle")) setReactionPicker(false);
});
window.addEventListener("resize", () => { setReactionPicker(false); $("onlineReactionFeed")?.replaceChildren(); });
$("onlineVideoGrid")?.addEventListener("scroll", () => $("onlineReactionFeed")?.replaceChildren());
$("onlineParticipantAvatars")?.addEventListener("scroll", () => $("onlineReactionFeed")?.replaceChildren());
$("onlineEndSessionButton")?.addEventListener("click", endSessionFromRoom);
$("onlineChatForm")?.addEventListener("submit", sendChatMessage);
$("onlineChatTab")?.addEventListener("click", () => switchSidebarTab("chat"));
$("onlineChatNotificationOpen")?.addEventListener("click", openChatNotification);
$("onlineChatNotificationClose")?.addEventListener("click", hideChatNotification);
$("onlineChatNotification")?.addEventListener("mouseleave", () => {
  if (!$("onlineChatNotification")?.contains(document.activeElement)) hideChatNotification();
});
$("onlineChatNotification")?.addEventListener("focusout", (event) => {
  if (!$("onlineChatNotification")?.contains(event.relatedTarget)) hideChatNotification();
});
$("onlineHandsTab")?.addEventListener("click", () => switchSidebarTab("hands"));
$("onlineHandVoiceButton")?.addEventListener("click", toggleHandVoiceAlerts);
$("onlineFullscreenButton")?.addEventListener("click", toggleFullscreen);
$("onlineMiniRoomButton")?.addEventListener("click", openMiniRoom);
$("onlineRoomSoundButton")?.addEventListener("click", toggleRoomSounds);
$("onlineSidebarToggleButton")?.addEventListener("click", toggleFullscreenSidebar);
document.addEventListener("fullscreenchange", updateFullscreenButton);
document.addEventListener("keydown", handleRoomFullscreenEscape);
window.addEventListener("pagehide", () => { void closeAttendanceVisit(); });
updateRoomSoundButton();
updateFullscreenButton();
setupMenu();

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.member = null;
  state.targetMembers = [];
  state.selectedTargets.clear();
  if ($("onlineTargetMembers")) $("onlineTargetMembers").innerHTML = "";
  setHeroCta(false);
  state.sessionsUnsubscribe?.();
  state.sessionsUnsubscribe = null;
  $("onlineMemberPanel")?.classList.add("hidden");
  if (!user) {
    setHeroCta(false);
    $("onlineInvalidSignOut")?.classList.add("hidden");
    setAuthMessage("Use the same email and password as your NAWRAS EDU team account.");
    return;
  }
  try {
    const profile = await getDoc(doc(db, "teamMembers", user.uid));
    if (!profile.exists() || profile.data().active !== true || !VALID_ROLES.has(profile.data().role)) {
      setHeroCta(false);
      $("onlineInvalidSignOut")?.classList.remove("hidden");
      setAuthMessage("This account is not an active NAWRAS EDU team member. Ask an admin to check your account.");
      return;
    }
    const data = profile.data();
    state.member = { uid: user.uid, ...data };
    setSignedInUI();
    void loadSessionTargetMembers();
    listenForSessions();
  } catch (error) {
    console.error("Could not verify NawrasOnline membership:", error);
    $("onlineInvalidSignOut")?.classList.remove("hidden");
    setAuthMessage("We could not verify this account. Check your connection and Firebase rules, then try again.");
  }
});

$("onlineInvalidSignOut")?.addEventListener("click", () => signOut(auth));
