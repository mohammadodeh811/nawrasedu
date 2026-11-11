import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, deleteUser, signInAnonymously, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, deleteField, query, where, orderBy, serverTimestamp, runTransaction, writeBatch, onSnapshot } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { SOCIAL_PLATFORMS, validateSocialLinks, socialLinksMarkup } from "./member-socials.js";
import { createPersonalPlanner } from "./personal-calendar.js";
import { isSessionForMember } from "./personal-calendar-core.js";
import { PERMISSION_GROUPS, DASHBOARD_ACCESS_CAPABILITIES, dashboardCapabilityLabel, hasCapability, loadMemberCapabilities, resourceCapability, expandCapabilities } from "./dashboard-permissions.js";
import { isDriveStorageConfigured, driveProfilePhotoUrl, driveProfileStickerUrl, uploadDriveFile, requestDrivePreviewTicket, requestDriveProfileStickerPreview, retireDriveProfilePhoto, retireDriveProfileSticker } from "./drive-storage.js?v=20261111-profile-sticker-controls";
import { createCrossTeamWork } from "./cross-team-work.js?v=20261111-workflow-dashboard-role-access-fix";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let registrationWaiter = null;
let personalPlanner = null;
const page = document.body.dataset.page || "home";
const $ = (id) => document.getElementById(id);
// Remove only the retired push workers; leave unrelated/offline workers alone.
void retireLegacyPushRegistrations();
// Retire the public schedule everywhere, including older uploaded page headers.
document.querySelectorAll('a[href="schedule.html"]').forEach((link) => {
  if (link.classList.contains("directory-card")) {
    link.href = "admin.html?view=calendar";
    const title = link.querySelector("h3"), copy = link.querySelector("p"), action = link.querySelector(".directory-link");
    if (title) title.textContent = "My calendar";
    if (copy) copy.textContent = "Your sessions and personal plans, together in your dashboard.";
    if (action) action.textContent = "Open my calendar →";
  } else link.remove();
});
document.querySelectorAll(".schedule-admin-panel, #scheduleModal").forEach((node) => node.remove());
document.querySelectorAll("#timelineList, #onlineScheduleList").forEach((node) => node.closest("section")?.remove());
const state = {
  user: null, isTeam: false, role: null, member: null, activeDashboardRole: null,
  activeDashboardSection: "overview",
  courses: [], assignedCourses: [], assignedCoursesUnsubscribe: null, courseAssignments: [], forms: [], memberForms: [], schedule: [], onlineScheduleSessions: [], questions: [], tasks: [], taskSubmissions: {}, teamMembers: [], leaderboardMembers: [], fieldBuilder: [],
  attendanceSessions: [], attendanceSession: null, attendanceVisits: [], attendanceOverrides: new Map(), attendanceRows: [],
  founderQuestions: [], founderQuestionsLoadGeneration: 0,
  technicalMaterials: [], roleResources: [], roleResourceLoadWarning: "", dashboardCapabilities: {}, dashboardGrants: [],
  chatPartner: null, chatThreads: [], activeChatId: "", chatMessages: [], chatProfiles: {}, chatThreadsUnsubscribe: null, chatMessagesUnsubscribe: null, chatMessagesChatId: "",
  selectedDay: 4, userSelectedDay: false, searchQuery: "", selectedCategory: "all",
  profilePhotoFile: null, profilePhotoPreviewUrl: "",
  inboxMessages: [], inboxUnsubscribe: null, inboxFilterGeneration: 0,
  inboxSessionAccessUid: "", inboxSessionAccess: new Map(), selectedRatingUid: "", myRating: null
};
let taskSelectedMemberUids = new Set();

const refs = {
  publicCoursesGrid: $("publicCoursesGrid"), publicFormsGrid: $("publicFormsGrid"),
  teamCoursesList: $("teamCoursesList"), teamFormsList: $("teamFormsList"),
  courseCount: $("courseCount"), formCount: $("formCount"),
  courseCountLabel: $("courseCountLabel"), formCountLabel: $("formCountLabel"),
  teamWelcome: $("teamWelcome"), dashboard: $("dashboard"), dashboardLayout: $("dashboardLayout"),
  adminLoginView: $("adminLoginView"), responsesViewer: $("responsesViewer"),
  emptyResponsesState: $("emptyResponsesState"), courseSearch: $("courseSearch"),
  courseCategoryFilter: $("courseCategoryFilter"), roleDashboardNav: $("roleDashboardNav"),
  dashboardSectionNav: $("dashboardSectionNav"),
  roleWorkspace: $("roleWorkspace"), sharedManagement: $("sharedManagement"),
  teamScheduleList: $("teamScheduleList"), teamQuestionsList: $("teamQuestionsList"),
  tasksPanel: $("tasksPanel"), tasksPanelTitle: $("tasksPanelTitle"), tasksPanelHint: $("tasksPanelHint"),
  tasksList: $("tasksList"), taskSubmissionsViewer: $("taskSubmissionsViewer"),
  assignedCoursesList: $("assignedCoursesList"), memberFormsList: $("memberFormsList"), memberFormsCount: $("memberFormsCount"),
  technicalMaterialsGrid: $("technicalMaterialsGrid"), technicalMaterialsCount: $("technicalMaterialsCount"),
  leaderboardPanel: $("leaderboardPanel"), leaderboardTitle: $("leaderboardTitle"),
  leaderboardHint: $("leaderboardHint"), leaderboardList: $("leaderboardList"),
  teamMembersPanel: $("teamMembersPanel"), teamMembersList: $("teamMembersList"),
  dashboardAccessPanel: $("dashboardAccessPanel"), dashboardAccessGrantsList: $("dashboardAccessGrantsList"),
  chatPanel: $("chatPanel"), chatPanelTitle: $("chatPanelTitle"), chatPanelHint: $("chatPanelHint"),
  chatConversationList: $("chatConversationList"), chatMessages: $("chatMessages"), chatForm: $("chatForm"),
  chatInput: $("chatInput"), chatSendButton: $("chatSendButton"),
  designerResourcesPanel: $("designerResourcesPanel"),
  roleResourcesGrid: $("roleResourcesGrid"), roleResourcesCount: $("roleResourcesCount"),
  publicQuestionsList: $("publicQuestionsList"), publicQuestionCount: $("publicQuestionCount"),
  askQuestionForm: $("askQuestionForm"), askQuestion: $("askQuestion"),
  askTargetRole: $("askTargetRole"), askQuestionCount: $("askQuestionCount"),
  ratingsPanel: $("ratingsPanel"), ratingsMatrix: $("ratingsMatrix"),
  myRatingsContent: $("myRatingsContent"), myRatingsUpdated: $("myRatingsUpdated"),
  attendancePanel: $("attendancePanel"), attendanceSessionSelect: $("attendanceSessionSelect"),
  attendanceSessionMeta: $("attendanceSessionMeta"), attendanceTableRoot: $("attendanceTableRoot"),
  exportAttendanceBtn: $("exportAttendanceBtn")
};

const ROLE_CONFIG = {
  admin: { label: "Admin", eyebrow: "ADMIN WORKSPACE", description: "Access every dashboard and every management area.", tools: ["All dashboards", "Team administration", "Content oversight", "Schedule and board controls"] },
  user: { label: "User", eyebrow: "USER WORKSPACE", description: "A general team account with only the dashboards and team work assigned by an admin.", tools: ["Your assigned work", "Team updates", "Your profile"] },
  leaders: { label: "Leaders", eyebrow: "LEADERS WORKSPACE", description: "A focused space for leadership planning, priorities, and team follow-up.", tools: ["Leadership planning", "Team priorities", "Reports placeholder"] },
  public: { label: "Public", eyebrow: "PUBLIC WORKSPACE", description: "A focused space for public-facing activity and community follow-up.", tools: ["Community requests", "Public activity", "Notes placeholder"] },
  tech: { label: "Technical", eyebrow: "TECHNICAL WORKSPACE", description: "Browse shared training materials and manage courses, live training times, and session boards.", tools: ["Technical materials", "Course manager", "Schedule editor"] },
  social: { label: "Social", eyebrow: "SOCIAL WORKSPACE", description: "A dedicated area for social planning and future publishing tools.", tools: ["Social calendar", "Campaign ideas", "Publishing placeholder"] },
  designers: { label: "Designers", eyebrow: "DESIGNERS WORKSPACE", description: "A dedicated area for design requests, references, and future creative tools.", tools: ["Design requests", "Creative references", "Assets placeholder"] },
  content: { label: "Content", eyebrow: "CONTENT WORKSPACE", description: "A dedicated area for editorial planning and future content tools.", tools: ["Editorial calendar", "Draft ideas", "Content placeholder"] },
  event: { label: "Event", eyebrow: "EVENT WORKSPACE", description: "A dedicated area for event planning, logistics, and future event tools.", tools: ["Event plans", "Logistics checklist", "Event placeholder"] }
};
const ROLE_ORDER = ["admin", "user", "leaders", "public", "tech", "social", "designers", "content", "event"];
const ASSIGNABLE_DASHBOARD_ROLES = ["user", "leaders", "public", "tech", "social", "designers", "content", "event"];
const DIRECTORY_ROLE_ORDER = ROLE_ORDER.filter((roleKey) => roleKey !== "user");
const crossTeamWork = createCrossTeamWork({
  db,
  getContext: () => ({
    user: state.user, member: state.member, role: state.role,
    teamLeadRoles: currentTeamLeadRoles(),
    dashboardRoles: Array.isArray(state.member?.dashboardRoles) ? state.member.dashboardRoles : []
  }),
  canManage: () => state.role === "admin" || currentTeamLeadRoles().includes("event"),
  notifyInboxMembers,
  toast: showToast
});
const CONTENT_ROLES = ["admin", "tech"];
const XP_PER_ANSWER = 50;
const XP_PER_LEVEL = 100;
const RATING_CATEGORIES = [
  { key: "commitment", label: "الالتزام" },
  { key: "projects", label: "المشاريع" },
  { key: "participation", label: "المشاركة" },
  { key: "initiative", label: "المبادرة" },
  { key: "teamwork", label: "التعاون" },
  { key: "quality", label: "جودة العمل" }
];
const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024;
const UNIVERSITY_OPTIONS = [
  { tag: "AAUP-Jenin", name: "الجامعة العربية الأمريكية-جنين" },
  { tag: "AAUP-Ramallah", name: "الجامعة الامريكية-رام الله" },
  { tag: "BZU", name: "جامعة بيرزيت" },
  { tag: "NNU", name: "جامعة النجاح" },
  { tag: "PPU", name: "جامعة بوليتكنك" },
  { tag: "PTUK", name: "جامعة خضوري" }
];
const UNIVERSITY_BY_TAG = Object.fromEntries(UNIVERSITY_OPTIONS.map((university) => [university.tag, university]));

const DEFAULT_ROLE_RESOURCES = {
  designers: [
    { id: "starter-google-fonts", title: "Google Fonts", description: "Browse typefaces and build font pairings.", url: "https://fonts.google.com/", kind: "tool" },
    { id: "starter-texturelabs", title: "TextureLabs", description: "Find textures, overlays, and visual surfaces.", url: "https://texturelabs.org/", kind: "inspiration" },
    { id: "starter-hera-motion", title: "HERA Motion Graphics", description: "Explore motion design references and ideas.", url: "https://hera.video/", kind: "inspiration" },
    { id: "starter-eye-candy", title: "Eye Candy", description: "Collect visual effects and creative assets.", url: "https://eyecannndy.com/", kind: "inspiration" },
    { id: "starter-color-hexa", title: "Color Hexa", description: "Research color values, shades, and palettes.", url: "https://www.colorhexa.com/", kind: "tool" },
    { id: "starter-design-readings", title: "Design & UI/UX readings", description: "Browse books and learning resources on GitHub.", url: "https://github.com/ytx-readings/design-ui-ux", kind: "book" },
    { id: "starter-canva", title: "Canva", description: "Create social graphics, presentations, and more.", url: "https://www.canva.com/", kind: "tool" },
    { id: "starter-photoshop", title: "Adobe Photoshop", description: "Visit Adobe for official Photoshop information and trial details.", url: "https://www.adobe.com/products/photoshop.html", kind: "tool" }
  ]
};

if ($("year")) $("year").textContent = new Date().getFullYear();

async function retireLegacyPushRegistrations() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const legacyNames = new Set(["OneSignalSDKWorker.js", "OneSignalSDKUpdaterWorker.js", "firebase-messaging-sw.js"]);
    const registrations = await navigator.serviceWorker.getRegistrations();
    const retired = registrations.filter((registration) => {
      const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
      return workers.length > 0 && workers.every((worker) => legacyNames.has(new URL(worker.scriptURL).pathname.split("/").pop()));
    });
    await Promise.allSettled(retired.map(async (registration) => {
      try {
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription) await subscription.unsubscribe();
      } finally {
        await registration.unregister();
      }
    }));
  } catch (_) {
    // Cleanup must never prevent the public pages or sign-in from loading.
  }
}

function showToast(message, type = "ok") {
  const root = $("toastRoot");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast${type === "error" ? " error" : ""}`;
  node.textContent = message;
  root.appendChild(node);
  window.setTimeout(() => node.remove(), 3800);
}

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.add("hidden");
  if (!document.querySelector(".modal:not(.hidden)")) document.body.style.overflow = "";
}

function setupNavigation() {
  const toggle = $("menuToggle");
  const nav = $("primaryNav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => nav.classList.remove("open")));
}

document.addEventListener("click", (event) => {
  const closer = event.target.closest("[data-close-modal]");
  if (closer) {
    if (closer.dataset.closeModal === "drivePreviewModal") closeDrivePreview();
    else closeModal(closer.dataset.closeModal);
  }
});

setupNavigation();
if (refs.dashboardSectionNav) refs.dashboardSectionNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dashboard-section]");
  if (!button) return;
  state.activeDashboardSection = button.dataset.dashboardSection;
  renderDashboard();
  refs.dashboardSectionNav.querySelector(`[data-dashboard-section="${cssEscape(state.activeDashboardSection)}"]`)?.focus({ preventScroll: true });
});
if ($("founderQuestionForm")) $("founderQuestionForm").addEventListener("submit", submitFounderQuestion);
bindLinkEditors($("founderQuestionForm"));
if ($("founderAskJump")) $("founderAskJump").addEventListener("click", () => {
  $("founderAskJump").classList.toggle("is-ringing");
  $("founderQuestionForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => $("founderQuestionText")?.focus({ preventScroll: true }), 180);
});
if ($("founderRoleFilter")) $("founderRoleFilter").addEventListener("change", renderFounderQuestions);
if ($("founderStatusFilter")) $("founderStatusFilter").addEventListener("change", renderFounderQuestions);
if ($("founderQuestionSearch")) $("founderQuestionSearch").addEventListener("input", renderFounderQuestions);
if ($("founderAdminQuestionsList")) $("founderAdminQuestionsList").addEventListener("click", (event) => {
  const answerButton = event.target.closest("[data-founder-question-answer]");
  if (answerButton) return void answerFounderQuestion(answerButton.dataset.founderQuestionAnswer);
  const deleteButton = event.target.closest("[data-founder-question-delete]");
  if (deleteButton) void deleteFounderQuestion(deleteButton.dataset.founderQuestionDelete);
});

if (refs.courseSearch) refs.courseSearch.addEventListener("input", (event) => {
  state.searchQuery = event.target.value.toLowerCase().trim();
  filterAndRenderCourses();
});

if (refs.courseCategoryFilter) refs.courseCategoryFilter.addEventListener("change", (event) => {
  state.selectedCategory = event.target.value;
  filterAndRenderCourses();
});

if ($("loginForm")) $("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    $("loginForm").reset();
    showToast("Signed in successfully.");
  } catch (error) {
    showToast(friendlyAuthError(error), "error");
  }
});

if ($("privateFormLoginForm")) $("privateFormLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("privateFormLoginStatus");
  const button = $("privateFormLoginForm").querySelector('button[type="submit"]');
  if (status) status.textContent = "Signing in…";
  if (button) button.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("privateFormEmail").value.trim(), $("privateFormPassword").value);
    if (status && !$("privateFormLoginGate")?.classList.contains("hidden")) {
      status.textContent = "Signed in. Checking this form’s audience…";
    }
  } catch (error) {
    if (status) status.textContent = friendlyAuthError(error);
    if (button) button.disabled = false;
  }
});

if ($("managedFormAudience")) {
  $("managedFormAudience").addEventListener("change", syncFormAudienceFields);
  syncFormAudienceFields();
}

if ($("addTechnicalMaterialBtn")) $("addTechnicalMaterialBtn").addEventListener("click", openTechnicalMaterialEditor);
if ($("technicalMaterialForm")) $("technicalMaterialForm").addEventListener("submit", saveTechnicalMaterial);
if (refs.technicalMaterialsGrid) refs.technicalMaterialsGrid.addEventListener("click", handleTechnicalMaterialsClick);
if ($("technicalMaterialFile")) $("technicalMaterialFile").addEventListener("change", () => {
  const file = $("technicalMaterialFile").files?.[0];
  if (file) {
    $("technicalMaterialUrl").value = "";
    $("technicalMaterialCurrentFile").textContent = `Selected: ${file.name}. It uploads when you save.`;
  }
});
if ($("addRoleResourceBtn")) $("addRoleResourceBtn").addEventListener("click", () => openRoleResourceEditor());
if ($("roleResourceForm")) $("roleResourceForm").addEventListener("submit", saveRoleResource);
if (refs.roleResourcesGrid) refs.roleResourcesGrid.addEventListener("click", handleRoleResourcesClick);
if (refs.tasksList) {
  refs.tasksList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-open-task-card]");
    if (card && refs.tasksList.contains(card)) openTaskDetails(card.dataset.openTaskCard);
  });
  refs.tasksList.addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-open-task-card]");
    if (!card || event.target !== card || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openTaskDetails(card.dataset.openTaskCard);
  });
}
if ($("roleResourceFile")) $("roleResourceFile").addEventListener("change", () => {
  const file = $("roleResourceFile").files?.[0];
  if (file) {
    $("roleResourceUrl").value = "";
    $("roleResourceCurrentFile").textContent = `Selected: ${file.name}. It uploads when you save.`;
  }
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#clearMemberInboxBtn")) clearMemberInbox();
});
if ($("closeTechnicalMaterialPreviewBtn")) $("closeTechnicalMaterialPreviewBtn").addEventListener("click", closeTechnicalMaterialPreview);

if ($("signupForm")) $("signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = $("signupName").value.trim();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  const confirmPassword = $("signupPasswordConfirm").value;
  const submitButton = $("signupForm").querySelector('button[type="submit"]');
  if (!displayName) return showToast("Enter a display name.", "error");
  if (password !== confirmPassword) return showToast("The passwords do not match.", "error");
  if (password.length < 8) return showToast("Choose a password with at least 8 characters.", "error");
  if (submitButton) submitButton.disabled = true;

  let finishRegistration;
  let createdUser = null;
  registrationWaiter = new Promise((resolve) => { finishRegistration = resolve; });
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    createdUser = credential.user;
    await setDoc(doc(db, "teamMembers", credential.user.uid), {
      uid: credential.user.uid,
      displayName,
      photoURL: "",
      bio: "",
      socialLinks: {},
      role: "user",
      active: true,
      dashboardRoles: ["user"],
      universityTag: "",
      leadingUniversityTag: "",
      xp: 0,
      level: 1,
      answersCount: 0,
      tasksCompleted: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    $("signupForm").reset();
    showToast("Account created. You are signed in as User.");
  } catch (error) {
    if (createdUser) {
      let removedIncompleteAccount = false;
      try {
        await deleteUser(createdUser);
        removedIncompleteAccount = true;
      } catch (_) {}
      showToast(
        removedIncompleteAccount
          ? `Profile setup failed (${firebaseError(error)}). The incomplete login was removed; check Firebase settings and try again.`
          : `Profile setup failed (${firebaseError(error)}). The Firebase login may exist without a profile; ask an admin to check it.`,
        "error"
      );
    } else {
      showToast(friendlyAuthError(error), "error");
    }
    if (auth.currentUser) await signOut(auth).catch(() => {});
  } finally {
    registrationWaiter = null;
    finishRegistration?.();
    if (submitButton) submitButton.disabled = false;
  }
});

if ($("resetPasswordBtn")) $("resetPasswordBtn").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) return showToast("Enter your team email first.", "error");
  try {
    await sendPasswordResetEmail(auth, email);
    showToast("Password reset email sent.");
  } catch (error) {
    showToast(friendlyAuthError(error), "error");
  }
});

if ($("logoutBtn")) $("logoutBtn").addEventListener("click", async () => {
  try {
    await signOut(auth);
    showToast("You have been logged out.");
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
});

if ($("addCourseBtn")) $("addCourseBtn").addEventListener("click", () => openCourseEditor());
if ($("addFormBtn")) $("addFormBtn").addEventListener("click", () => openFormEditor());
if ($("addScheduleBtn")) $("addScheduleBtn").addEventListener("click", () => openScheduleEditor());
if ($("addTaskBtn")) $("addTaskBtn").addEventListener("click", () => openTaskEditor());
if ($("resetAllXpBtn")) $("resetAllXpBtn").addEventListener("click", () => resetAllMemberValues("xp"));
if ($("resetAllRatingsBtn")) $("resetAllRatingsBtn").addEventListener("click", () => resetAllMemberValues("ratings"));
if ($("addFieldBtn")) $("addFieldBtn").addEventListener("click", () => {
  state.fieldBuilder.push(newField());
  renderFieldBuilder();
});
if ($("courseForm")) $("courseForm").addEventListener("submit", saveCourse);
if ($("addCourseAssetBtn")) $("addCourseAssetBtn").addEventListener("click", addCourseAssetRow);
if ($("courseAssetRows")) $("courseAssetRows").addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-course-asset]");
  if (!removeButton) return;
  removeButton.closest("[data-course-asset-row]")?.remove();
  if (!$("courseAssetRows").querySelector("[data-course-asset-row]")) renderCourseAssetEmptyState();
});
if ($("courseAssetRows")) $("courseAssetRows").addEventListener("change", (event) => {
  const fileInput = event.target.closest("[data-course-asset-file]");
  if (!fileInput?.files?.[0]) return;
  const row = fileInput.closest("[data-course-asset-row]");
  const urlInput = row?.querySelector("[data-course-asset-url]");
  if (urlInput) urlInput.value = "";
  const existing = row?.querySelector("[data-course-asset-existing]");
  if (existing) existing.textContent = `Selected: ${fileInput.files[0].name}. It uploads when you save the course.`;
});
if ($("courseAssigneeSearch")) $("courseAssigneeSearch").addEventListener("input", () => {
  renderCourseAssignees(selectedCourseAssignees());
});
if ($("formBuilder")) $("formBuilder").addEventListener("submit", saveManagedForm);
if ($("scheduleForm")) $("scheduleForm").addEventListener("submit", saveSchedule);
  if ($("taskForm")) $("taskForm").addEventListener("submit", saveTask);
  if ($("taskImageFile")) $("taskImageFile").addEventListener("change", previewTaskCoverSelection);
if ($("taskTargetRole")) $("taskTargetRole").addEventListener("change", () => refreshTaskMemberSelector([]));
if ($("taskTargetUniversity")) $("taskTargetUniversity").addEventListener("change", () => refreshTaskMemberSelector([]));
if ($("taskMemberSearch")) $("taskMemberSearch").addEventListener("input", () => refreshTaskMemberSelector());
if ($("taskAssignedMembers")) $("taskAssignedMembers").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  if (input.checked) taskSelectedMemberUids.add(input.value);
  else taskSelectedMemberUids.delete(input.value);
});
  setupTaskExtraFields();
if ($("profileForm")) {
  addProfilePhotoControls();
  addProfileSocialControls();
  $("profileForm").addEventListener("submit", saveProfile);
}
if (refs.chatForm) refs.chatForm.addEventListener("submit", sendChatMessage);
if (refs.askQuestionForm) refs.askQuestionForm.addEventListener("submit", submitQuestion);
if (refs.askQuestion) refs.askQuestion.addEventListener("input", () => {
  if (refs.askQuestionCount) refs.askQuestionCount.textContent = `${refs.askQuestion.value.length} / 1000`;
});
refs.teamMembersList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-member-active]");
  if (button) void setTeamMemberActive(button.dataset.toggleMemberActive, button);
});
if ($("dashboardAccessScopeType")) {
  $("dashboardAccessScopeType").addEventListener("change", () => {
    if ($("dashboardAccessTarget")) $("dashboardAccessTarget").value = "";
    renderDashboardAccessTarget();
    populateDashboardAccessChecks([]);
  });
  $("dashboardAccessTarget")?.addEventListener("change", syncDashboardAccessChecks);
  $("dashboardAccessMemberSearch")?.addEventListener("input", () => renderDashboardAccessTarget());
  $("dashboardAccessForm")?.addEventListener("submit", saveDashboardAccessGrant);
  $("dashboardAccessGrantsList")?.addEventListener("click", handleDashboardAccessGrantClick);
}

function canManageContent() {
  return CONTENT_ROLES.includes(state.role);
}

function canManageForms() {
  return ["admin", "tech", "public"].includes(state.role) || hasDashboardAccess("formsManage");
}

function hasDashboardAccess(capability) {
  if (state.role === "admin") return true;
  return hasCapability(state.dashboardCapabilities, capability);
}

function canReadAttendance() { return hasDashboardAccess("attendanceRead"); }
function canManageAttendance() { return hasDashboardAccess("attendanceManage"); }
function canManageMemberAssignments(member = null) {
  return state.role === "admin" || (hasDashboardAccess("membersManage")
    && (!member || (member.role !== "admin" && member.uid !== state.user?.uid && member.active !== false)));
}
function canReadAllRatings() { return hasDashboardAccess("ratingsRead"); }
function canReadAllTeam() { return hasDashboardAccess("teamRead"); }

function canReadManagedForms() {
  return canManageForms() || hasDashboardAccess("formsRead") || hasDashboardAccess("formsResponses");
}

function canReadFormResponses() {
  return canManageForms() || hasDashboardAccess("formsResponses");
}

function canManageCourses() {
  return canManageContent() || hasDashboardAccess("coursesManage");
}

function canReadCourses() {
  return canManageCourses() || hasDashboardAccess("coursesRead");
}

function canReadTechnicalMaterials() {
  return ["admin", "tech"].includes(state.role)
    || currentTeamLeadRoles().includes("tech")
    || hasDashboardAccess("technicalMaterialsRead");
}

function canManageTechnicalMaterials() {
  return state.role === "admin"
    || currentTeamLeadRoles().includes("tech")
    || hasDashboardAccess("technicalMaterialsManage");
}

function canViewDesignerResources(roleKey = state.activeDashboardRole) {
  return roleKey === "designers" || hasDashboardAccess("designerResourcesRead");
}

function canReadRoleResources(roleKey = state.activeDashboardRole) {
  if (!ASSIGNABLE_DASHBOARD_ROLES.includes(roleKey) || !state.isTeam) return false;
  const assignedDashboards = Array.isArray(state.member?.dashboardRoles) ? state.member.dashboardRoles : [];
  return state.role === "admin"
    || state.role === roleKey
    || (roleKey === "leaders" && isPositionLeader(state.member))
    || currentTeamLeadRoles().includes(roleKey)
    || assignedDashboards.includes(roleKey)
    || hasDashboardAccess(resourceCapability(roleKey));
}

function canManageRoleResources(roleKey) {
  return ASSIGNABLE_DASHBOARD_ROLES.includes(roleKey)
    && (state.role === "admin" || currentTeamLeadRoles().includes(roleKey)
      || hasDashboardAccess(resourceCapability(roleKey, "Manage")));
}

function isRoleLeaderForDashboard(roleKey) {
  if (state.role === "admin") {
    const assignment = adminTeamAssignment(state.member);
    return assignment?.position === "leader" && assignment.role === roleKey;
  }
  return currentTeamLeadRoles().includes(roleKey);
}

function dashboardGrantId(scopeType, target, capability) {
  return `${scopeType}_${target}_${capability}`;
}

function dashboardGrantTargetLabel(scopeType, target) {
  if (scopeType === "role") return ROLE_CONFIG[target]?.label || target;
  if (scopeType === "university") return universityLabel(target);
  const member = state.teamMembers.find((item) => item.uid === target);
  return member ? memberDisplayName(member) : `Member ${target}`;
}

function dashboardAccessRecipients(scopeType, target) {
  return state.teamMembers.filter((member) => member.active === true
    && member.role !== "admin"
    && (scopeType === "user"
      ? member.uid === target
      : scopeType === "role"
        ? member.role === target
        : scopeType === "university" && member.universityTag === target));
}

async function loadDashboardAccess() {
  let failed = false;
  state.dashboardCapabilities = await loadMemberCapabilities(db, state.member, () => { failed = true; });
  if (failed) showToast("Some granted tools could not be loaded. Check the updated Firestore rules and indexes.", "error");
}

function renderDashboardPermissionOptions() {
  const container = $("dashboardPermissionOptions");
  if (!container || container.dataset.ready === "true") return;
  container.dataset.ready = "true";
  container.innerHTML = PERMISSION_GROUPS.map((group, index) => `<details class="permission-group" ${index < 3 ? "open" : ""}>
    <summary>${escapeHtml(group.title)}${group.sensitive ? `<span class="permission-sensitive">Destructive</span>` : ""}</summary>
    <div class="permission-group-options">${group.items.map(([key, label]) => `<label class="check-row"><input type="checkbox" name="dashboardCapability" value="${escapeAttr(key)}"><span>${escapeHtml(label)}</span></label>`).join("")}</div>
  </details>`).join("");
  $("permissionSearch")?.addEventListener("input", (event) => {
    const queryText = event.target.value.trim().toLowerCase();
    container.querySelectorAll(".permission-group").forEach((group) => {
      const match = !queryText || group.textContent.toLowerCase().includes(queryText);
      group.hidden = !match;
      if (queryText && match) group.open = true;
    });
  });
  $("permissionSelectAll")?.addEventListener("click", () => {
    container.querySelectorAll('input[name="dashboardCapability"]').forEach((input) => {
      if (!input.closest(".permission-group").hidden) input.checked = true;
    });
  });
  $("permissionClearAll")?.addEventListener("click", () => populateDashboardAccessChecks([]));
}

async function loadDashboardGrantAdmin() {
  if (state.role !== "admin") return;
  renderDashboardPermissionOptions();
  try {
    const snapshot = await getDocs(collection(db, "dashboardAccessGrants"));
    state.dashboardGrants = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((grant) => grant.active === true)
      .sort((a, b) => `${a.scopeType}:${a.scopeTarget}:${a.capability}`.localeCompare(`${b.scopeType}:${b.scopeTarget}:${b.capability}`));
    renderDashboardAccessTarget();
    renderDashboardAccessGrantList();
  } catch (error) {
    state.dashboardGrants = [];
    if (refs.dashboardAccessGrantsList) refs.dashboardAccessGrantsList.innerHTML = `<div class="empty-state">Access grants could not be loaded. Deploy the updated Firestore rules.</div>`;
    showToast(`Dashboard access settings could not be loaded: ${firebaseError(error)}`, "error");
  }
}

function dashboardAccessSelection() {
  const scopeType = $("dashboardAccessScopeType")?.value || "role";
  const target = $("dashboardAccessTarget")?.value || "";
  return { scopeType, target };
}

function renderDashboardAccessTarget(selectedValue = "") {
  const scopeType = $("dashboardAccessScopeType")?.value || "role";
  const select = $("dashboardAccessTarget");
  const label = $("dashboardAccessTargetLabel");
  const memberSearchWrap = $("dashboardAccessMemberSearchWrap");
  const search = String($("dashboardAccessMemberSearch")?.value || "").trim().toLowerCase();
  if (!select) return;
  selectedValue = selectedValue || select.value;
  if (label?.firstChild) label.firstChild.textContent = scopeType === "role" ? "Role" : scopeType === "university" ? "University" : "Member";
  memberSearchWrap?.classList.toggle("hidden", scopeType !== "user");
  let options = [];
  if (scopeType === "role") {
    options = ASSIGNABLE_DASHBOARD_ROLES.map((role) => [role, ROLE_CONFIG[role].label]);
  } else if (scopeType === "university") {
    options = UNIVERSITY_OPTIONS.map((item) => [item.tag, item.name]);
  } else {
    options = state.teamMembers
      .filter((member) => member.active !== false && member.role !== "admin")
      .map((member) => [member.uid, `${memberDisplayName(member)} · ${ROLE_CONFIG[member.role]?.label || member.role}${member.universityTag ? ` · ${universityLabel(member.universityTag)}` : ""}`])
      .filter(([uid, text]) => !search || `${uid} ${text}`.toLowerCase().includes(search));
    if (selectedValue && !options.some(([uid]) => uid === selectedValue)) {
      const current = state.teamMembers.find((member) => member.uid === selectedValue && member.active !== false && member.role !== "admin");
      if (current) options.unshift([current.uid, `${memberDisplayName(current)} · ${ROLE_CONFIG[current.role]?.label || current.role}${current.universityTag ? ` · ${universityLabel(current.universityTag)}` : ""}`]);
    }
  }
  select.innerHTML = `<option value="">Choose ${scopeType === "role" ? "a role" : scopeType === "university" ? "a university" : "a member"}</option>`
    + options.map(([value, text]) => `<option value="${escapeAttr(value)}">${escapeHtml(text)}</option>`).join("");
  if (selectedValue && options.some(([value]) => value === selectedValue)) select.value = selectedValue;
  syncDashboardAccessChecks();
}

function populateDashboardAccessChecks(capabilities = []) {
  const selected = new Set(capabilities);
  document.querySelectorAll('[name="dashboardCapability"]').forEach((input) => { input.checked = selected.has(input.value); });
}

function syncDashboardAccessChecks() {
  const { scopeType, target } = dashboardAccessSelection();
  if (!target) return populateDashboardAccessChecks([]);
  const granted = state.dashboardGrants
    .filter((grant) => grant.scopeType === scopeType && grant.scopeTarget === target)
    .map((grant) => grant.capability);
  populateDashboardAccessChecks(granted);
}

function renderDashboardAccessGrantList() {
  const root = refs.dashboardAccessGrantsList;
  if (!root) return;
  const groups = new Map();
  for (const grant of state.dashboardGrants) {
    const key = `${grant.scopeType}:${grant.scopeTarget}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(grant);
  }
  root.innerHTML = groups.size ? `<div class="dashboard-access-grant-list">${[...groups.values()].map((grants) => {
    const first = grants[0];
    const scopeLabel = first.scopeType === "user" ? "Member" : first.scopeType === "role" ? "Role" : "University";
    return `<details class="permission-group"><summary>${escapeHtml(scopeLabel)} · ${escapeHtml(dashboardGrantTargetLabel(first.scopeType, first.scopeTarget))} <small>(${grants.length})</small></summary><div class="permission-group-options"><button class="btn btn-outline btn-compact" type="button" data-edit-dashboard-grant="${escapeAttr(first.id)}">Edit access set</button>${grants.map((grant) => `<article class="dashboard-access-grant-row"><strong>${escapeHtml(dashboardCapabilityLabel(grant.capability))}</strong><button class="btn btn-danger btn-compact" type="button" data-remove-dashboard-grant="${escapeAttr(grant.id)}">Remove</button></article>`).join("")}</div></details>`;
  }).join("")}</div>` : `<div class="empty-state">No extra access grants.</div>`;
}

async function saveDashboardAccessGrant(event) {
  event.preventDefault();
  if (state.role !== "admin") return showToast("Only admins can grant dashboard access.", "error");
  const { scopeType, target } = dashboardAccessSelection();
  const validTarget = scopeType === "role"
    ? ASSIGNABLE_DASHBOARD_ROLES.includes(target)
    : scopeType === "university"
      ? Boolean(universityByTag(target))
      : scopeType === "user" && state.teamMembers.some((member) => member.uid === target && member.active !== false && member.role !== "admin");
  if (!validTarget) return showToast("Choose a valid role, university, or active member.", "error");
  const selected = expandCapabilities([...document.querySelectorAll('[name="dashboardCapability"]:checked')].map((input) => input.value));
  if (selected.some((capability) => !DASHBOARD_ACCESS_CAPABILITIES.includes(capability))) return showToast("Choose only listed dashboard permissions.", "error");
  try {
    const previous = state.dashboardGrants.filter((grant) => grant.scopeType === scopeType && grant.scopeTarget === target);
    const previousSet = new Set(previous.map((grant) => grant.capability));
    if (!selected.length && !previous.length) return showToast("No dashboard access changes to save.", "info");
    const nextSet = new Set(selected);
    const batch = writeBatch(db);
    for (const capability of DASHBOARD_ACCESS_CAPABILITIES) {
      const ref = doc(db, "dashboardAccessGrants", dashboardGrantId(scopeType, target, capability));
      if (nextSet.has(capability)) {
        batch.set(ref, {
          scopeType, scopeTarget: target, capability, active: true,
          updatedByUid: state.user.uid, updatedAt: serverTimestamp()
        });
      } else if (previousSet.has(capability)) {
        batch.delete(ref);
      }
    }
    await batch.commit();
    const added = selected.filter((capability) => !previousSet.has(capability));
    const removed = [...previousSet].filter((capability) => !nextSet.has(capability));
    let notificationError = null;
    if (added.length || removed.length) {
      const recipients = dashboardAccessRecipients(scopeType, target);
      const scopeLabel = dashboardGrantTargetLabel(scopeType, target);
      const summary = (keys) => `${keys.slice(0, 3).map(dashboardCapabilityLabel).join(", ")}${keys.length > 3 ? `, and ${keys.length - 3} more` : ""}`;
      const details = [
        added.length ? `Granted: ${summary(added)}.` : "",
        removed.length ? `Removed: ${summary(removed)}.` : ""
      ].filter(Boolean).join(" ");
      try {
        await notifyInboxMembers(
          recipients,
          "dashboard_access",
          "Your dashboard access was updated",
          `${details} Sign in again or refresh your dashboard to see the updated tools. Target: ${scopeLabel}.`,
          { accessScopeType: scopeType, accessScopeTarget: target }
        );
      } catch (error) {
        notificationError = error;
      }
    }
    await loadDashboardGrantAdmin();
    syncDashboardAccessChecks();
    showToast(notificationError
      ? `Dashboard access saved, but inbox notices could not be sent: ${firebaseError(notificationError)}`
      : selected.length ? `Dashboard access saved for ${dashboardGrantTargetLabel(scopeType, target)}.`
        : `Dashboard access removed from ${dashboardGrantTargetLabel(scopeType, target)}.`,
      notificationError ? "error" : "ok");
  } catch (error) {
    showToast(`Could not save dashboard access: ${firebaseError(error)}`, "error");
  }
}

function handleDashboardAccessGrantClick(event) {
  const editButton = event.target.closest("[data-edit-dashboard-grant]");
  if (editButton) {
    const grant = state.dashboardGrants.find((item) => item.id === editButton.dataset.editDashboardGrant);
    if (!grant) return;
    $("dashboardAccessScopeType").value = grant.scopeType;
    if ($("dashboardAccessMemberSearch")) $("dashboardAccessMemberSearch").value = "";
    renderDashboardAccessTarget(grant.scopeTarget);
    syncDashboardAccessChecks();
    $("dashboardAccessForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const removeButton = event.target.closest("[data-remove-dashboard-grant]");
  if (!removeButton) return;
  const grant = state.dashboardGrants.find((item) => item.id === removeButton.dataset.removeDashboardGrant);
  if (!grant) return;
  const remaining = state.dashboardGrants.filter((item) => item.id !== grant.id
    && item.scopeType === grant.scopeType && item.scopeTarget === grant.scopeTarget).map((item) => item.capability);
  if (expandCapabilities(remaining).includes(grant.capability)) return showToast("This permission is included in another enabled action. Edit the access set and remove that action first.", "info");
  if (!window.confirm(`Remove “${dashboardCapabilityLabel(grant.capability)}” for ${dashboardGrantTargetLabel(grant.scopeType, grant.scopeTarget)}?`)) return;
  (async () => {
    try {
      await deleteDoc(doc(db, "dashboardAccessGrants", grant.id));
      let notificationError = null;
      try {
        await notifyInboxMembers(
          dashboardAccessRecipients(grant.scopeType, grant.scopeTarget),
          "dashboard_access",
          "Your dashboard access was updated",
          `${dashboardCapabilityLabel(grant.capability)} was removed. Refresh your dashboard to see the updated tools.`,
          { accessScopeType: grant.scopeType, accessScopeTarget: grant.scopeTarget }
        );
      } catch (error) { notificationError = error; }
      await loadDashboardGrantAdmin();
      syncDashboardAccessChecks();
      showToast(notificationError
        ? `Grant removed, but inbox notices could not be sent: ${firebaseError(notificationError)}`
        : "Dashboard access grant removed.", notificationError ? "error" : "ok");
    } catch (error) {
      showToast(firebaseError(error), "error");
    }
  })();
}

const ASK_ROLE_ORDER = ["leaders", "public", "tech", "social", "designers", "content", "event"];

async function submitQuestion(event) {
  event.preventDefault();
  const targetRole = refs.askTargetRole?.value;
  const question = refs.askQuestion?.value.trim();
  if (!ROLE_CONFIG[targetRole] || !ASK_ROLE_ORDER.includes(targetRole)) return showToast("Choose a team role first.", "error");
  if (!question || question.length < 8) return showToast("Please write a little more detail in your question.", "error");
  try {
    const asker = auth.currentUser || (await signInAnonymously(auth)).user;
    const questionRef = doc(collection(db, "questions"));
    await setDoc(questionRef, {
      question, targetRole, ownerUid: asker.uid, status: "open", answered: false, createdAt: serverTimestamp()
    });
    let notificationError = null;
    try {
      const members = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
      const recipients = members.docs.map((item) => ({ ...item.data(), uid: item.id }))
        .filter((member) => member.role === targetRole || adminTeamAssignment(member)?.role === targetRole);
      await notifyInboxMembers(recipients, "question_received", "A new question for your team",
        `A community question was sent to the ${ROLE_CONFIG[targetRole].label} team.`,
        { questionId: questionRef.id, actorUid: asker.uid, actorName: "Community member" },
        3, `question_${questionRef.id}`);
    } catch (error) { notificationError = error; }
    await loadMemberInbox(asker.uid);
    refs.askQuestionForm.reset();
    if (refs.askQuestionCount) refs.askQuestionCount.textContent = "0 / 1000";
    showToast(notificationError
      ? "Your question was saved, but the team's inbox notice could not be sent."
      : "Your question was saved and the selected team was notified.", notificationError ? "error" : "ok");
    openModal("questionSentModal");
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function submitFounderQuestion(event) {
  event.preventDefault();
  if (!state.user?.uid || !state.member || !ROLE_CONFIG[state.role]) {
    return showToast("Sign in with an active NAWRAS EDU account before messaging the founders.", "error");
  }
  const input = $("founderQuestionText");
  const question = input?.value.trim() || "";
  if (question.length < 8) return showToast("Please write at least 8 characters so the founders have enough context.", "error");
  if (question.length > 1500) return showToast("Keep your question under 1,500 characters.", "error");
  const linkResult = collectLinkEntries(findLinkEditor($("founderQuestionForm"), "founderQuestion"));
  if (linkResult.error) return showToast(linkResult.error, "error");
  const submit = $("founderQuestionSubmit");
  if (submit) {
    submit.disabled = true;
    submit.classList.add("is-sending");
    const label = submit.querySelector(".founder-send-copy");
    if (label) label.textContent = "Sending your question…";
  }
  try {
    const requestRef = doc(collection(db, "founderQuestions"));
    await setDoc(requestRef, {
      question,
      questionLinks: linkResult.links,
      ownerUid: state.user.uid,
      ownerName: memberDisplayName(state.member, state.user).slice(0, 80),
      ownerRole: state.role,
      status: "open",
      createdAt: serverTimestamp()
    });
    if (input) input.value = "";
    $("founderQuestionForm")?.querySelectorAll(".link-editor-rows").forEach((rows) => { rows.innerHTML = ""; });
    showToast("Your question has been sent privately to the founders.");
    await loadFounderQuestions();
  } catch (error) {
    showToast(`Your question could not be sent: ${firebaseError(error)}`, "error");
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.classList.remove("is-sending");
      const label = submit.querySelector(".founder-send-copy");
      if (label) label.textContent = "Send to the founders";
    }
  }
}

async function loadFounderQuestions() {
  const generation = ++state.founderQuestionsLoadGeneration;
  const uid = state.user?.uid || "";
  if (!uid || !state.member) return;
  const mine = $("founderMyQuestionsList");
  const queue = $("founderAdminQuestionsList");
  if (state.role === "admin" && queue) queue.innerHTML = `<div class="empty-state">Loading every role’s messages…</div>`;
  else if (mine) mine.innerHTML = `<div class="empty-state">Loading your messages…</div>`;
  try {
    const source = collection(db, "founderQuestions");
    const snapshot = state.role === "admin"
      ? await getDocs(source)
      : await getDocs(query(source, where("ownerUid", "==", uid)));
    if (generation !== state.founderQuestionsLoadGeneration || state.user?.uid !== uid) return;
    state.founderQuestions = snapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => sortTimestampDesc(a.createdAt, b.createdAt));
    renderFounderQuestions();
  } catch (error) {
    if (generation !== state.founderQuestionsLoadGeneration) return;
    const message = `Messages could not be loaded. ${firebaseError(error)}`;
    if (state.role === "admin" && queue) queue.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    else if (mine) mine.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    showToast(message, "error");
  }
}

function founderQuestionReplyMarkup(item) {
  return item.status === "answered"
    ? `<div class="founder-reply-card"><div class="founder-reply-heading"><span class="material-symbols-outlined" aria-hidden="true">mark_chat_read</span><div><strong>Founder reply</strong><small>${escapeHtml(item.answeredByName || "NAWRAS EDU founder")} · ${escapeHtml(formatDate(item.answeredAt))}</small></div></div><p>${escapeHtml(item.answer || "")}</p>${renderLinkButtons(item.answerLinks)}</div>`
    : `<div class="founder-waiting-note"><span class="material-symbols-outlined" aria-hidden="true">schedule</span><span>Sent to the founders · waiting for a reply</span></div>`;
}

function founderQuestionRoleCard(item) {
  const status = item.status === "answered" ? "Answered" : "Awaiting reply";
  return `<article class="founder-question-card ${item.status === "answered" ? "is-answered" : "is-open"}"><div class="founder-question-meta"><span class="founder-question-status ${item.status === "answered" ? "is-answered" : ""}">${status}</span><time>${escapeHtml(formatDate(item.createdAt))}</time></div><p class="founder-question-text">${escapeHtml(item.question || "")}</p>${renderLinkButtons(item.questionLinks)}${founderQuestionReplyMarkup(item)}</article>`;
}

function founderQuestionAdminCard(item) {
  const roleLabel = ROLE_CONFIG[item.ownerRole]?.label || item.ownerRole || "Member";
  return `<article class="founder-admin-question-card ${item.status === "answered" ? "is-answered" : "is-open"}"><div class="founder-admin-question-head"><div class="founder-admin-requester"><span class="founder-requester-avatar" aria-hidden="true">${escapeHtml(String(item.ownerName || "M").trim().charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(item.ownerName || "NAWRAS member")}</strong><small>${escapeHtml(roleLabel)} · ${escapeHtml(formatDate(item.createdAt))}</small></div></div><span class="founder-question-status ${item.status === "answered" ? "is-answered" : ""}">${item.status === "answered" ? "Answered" : "Needs a reply"}</span></div><p class="founder-question-text">${escapeHtml(item.question || "")}</p>${renderLinkButtons(item.questionLinks)}${item.status === "answered"
    ? `<div class="founder-reply-card"><div class="founder-reply-heading"><span class="material-symbols-outlined" aria-hidden="true">mark_chat_read</span><div><strong>Reply sent to ${escapeHtml(item.ownerName || "member")}</strong><small>${escapeHtml(item.answeredByName || "Admin")} · ${escapeHtml(formatDate(item.answeredAt))}</small></div></div><p>${escapeHtml(item.answer || "")}</p>${renderLinkButtons(item.answerLinks)}</div>`
    : `<form class="founder-admin-reply-form" data-founder-reply-form="${escapeAttr(item.id)}"><label for="founder-answer-${escapeAttr(item.id)}">Reply to ${escapeHtml(item.ownerName || "this member")}</label><textarea id="founder-answer-${escapeAttr(item.id)}" maxlength="1500" rows="3" placeholder="Write a thoughtful reply…" required></textarea>${linkEditorMarkup("founder-answer", `founderAnswer-${item.id}`, "Add a reply link", "Optional links to include with this reply.")}<button class="btn btn-primary btn-compact" type="button" data-founder-question-answer="${escapeAttr(item.id)}"><span class="material-symbols-outlined" aria-hidden="true">send</span> Send reply to inbox</button></form>`}<button class="btn btn-danger btn-compact founder-question-delete" type="button" data-founder-question-delete="${escapeAttr(item.id)}"><span class="material-symbols-outlined" aria-hidden="true">delete</span> Delete question</button></article>`;
}

function renderFounderQuestions() {
  const mine = $("founderMyQuestionsList");
  const adminList = $("founderAdminQuestionsList");
  const isAdmin = state.role === "admin";
  $("founderPanel")?.setAttribute("data-role-theme", state.activeDashboardRole || state.role || "user");
  $("founderAdminQueue")?.classList.toggle("hidden", !isAdmin);
  $("founderMyQuestions")?.classList.toggle("hidden", isAdmin);
  if ($("founderIntroCopy")) {
    $("founderIntroCopy").textContent = isAdmin
      ? "Review private messages from every team role and send each reply directly to the member’s inbox."
      : `Send Nawras and Duha a private question as ${ROLE_CONFIG[state.role]?.label || "a NAWRAS EDU member"}. Replies will arrive in your inbox.`;
  }
  if (mine && !isAdmin) {
    mine.innerHTML = state.founderQuestions.length
      ? state.founderQuestions.map(founderQuestionRoleCard).join("")
      : `<div class="founder-empty-state"><span class="material-symbols-outlined" aria-hidden="true">forum</span><strong>Your first note can start here.</strong><p>Questions and private founder replies will appear here.</p></div>`;
  }
  if (!isAdmin || !adminList) return;

  const roleFilter = $("founderRoleFilter");
  const statusFilter = $("founderStatusFilter");
  if (roleFilter && roleFilter.options.length < ROLE_ORDER.length + 1) {
    const previous = roleFilter.value || "all";
    roleFilter.innerHTML = `<option value="all">All roles</option>${ROLE_ORDER.map((role) => `<option value="${escapeAttr(role)}">${escapeHtml(ROLE_CONFIG[role]?.label || role)}</option>`).join("")}`;
    roleFilter.value = ROLE_ORDER.includes(previous) ? previous : "all";
  }
  const search = ($("founderQuestionSearch")?.value || "").trim().toLowerCase();
  const selectedRole = roleFilter?.value || "all";
  const selectedStatus = statusFilter?.value || "all";
  const filtered = state.founderQuestions.filter((item) => {
    const statusMatch = selectedStatus === "all" || item.status === selectedStatus;
    const roleMatch = selectedRole === "all" || item.ownerRole === selectedRole;
    const searchMatch = !search || `${item.ownerName || ""} ${item.question || ""} ${ROLE_CONFIG[item.ownerRole]?.label || item.ownerRole || ""}`.toLowerCase().includes(search);
    return statusMatch && roleMatch && searchMatch;
  });
  const openCount = state.founderQuestions.filter((item) => item.status === "open").length;
  if ($("founderQueueCount")) $("founderQueueCount").textContent = `${openCount} awaiting · ${state.founderQuestions.length} total`;
  const visibleRoles = selectedRole === "all" ? ROLE_ORDER : [selectedRole];
  adminList.innerHTML = visibleRoles.map((role) => {
    const items = filtered.filter((item) => item.ownerRole === role);
    return `<section class="founder-role-group"><div class="founder-role-group-heading"><h4>${escapeHtml(ROLE_CONFIG[role]?.label || role)}</h4><span>${items.length} message${items.length === 1 ? "" : "s"}</span></div>${items.length
      ? items.map(founderQuestionAdminCard).join("")
      : `<div class="founder-role-empty">${search || selectedStatus !== "all" ? "No matching questions." : "No questions from this role yet."}</div>`}</section>`;
  }).join("");
  bindLinkEditors(adminList);
}

async function answerFounderQuestion(id) {
  if (state.role !== "admin" || !state.user?.uid) return showToast("Only admins can answer founder messages.", "error");
  const item = state.founderQuestions.find((question) => question.id === id);
  if (!item || item.status !== "open" || !item.ownerUid) return showToast("This message has already been answered or is unavailable.", "error");
  const answer = $(`founder-answer-${id}`)?.value.trim() || "";
  if (answer.length < 8) return showToast("Write at least 8 characters in your reply.", "error");
  const answerLinks = collectLinkEntries(findLinkEditor($("founderAdminQuestionsList"), `founderAnswer-${id}`));
  if (answerLinks.error) return showToast(answerLinks.error, "error");
  const requestRef = doc(db, "founderQuestions", id);
  const notificationRef = doc(db, "teamMembers", item.ownerUid, "notifications", `founder-answer_${id}`);
  const adminName = memberDisplayName(state.member, state.user).slice(0, 80);
  try {
    await runTransaction(db, async (transaction) => {
      const requestSnapshot = await transaction.get(requestRef);
      if (!requestSnapshot.exists() || requestSnapshot.data().status !== "open"
        || requestSnapshot.data().ownerUid !== item.ownerUid) {
        throw new Error("This message was answered by another admin. Refresh the queue.");
      }
      transaction.update(requestRef, {
        status: "answered", answer, answeredByUid: state.user.uid,
        answerLinks: answerLinks.links, answeredByName: adminName, answeredAt: serverTimestamp()
      });
      transaction.set(notificationRef, inboxNotificationData(
        "founder_answer",
        "A founder replied to your question",
        "Your private question has a reply from the NAWRAS EDU founders.",
        {
          questionId: id, founderQuestion: item.question, founderAnswer: answer,
          founderQuestionLinks: item.questionLinks || [], founderAnswerLinks: answerLinks.links
        }
      ));
    });
    showToast(`Your reply was sent to ${item.ownerName || "the member"}’s inbox.`);
    await loadFounderQuestions();
  } catch (error) {
    showToast(`The reply could not be sent: ${firebaseError(error)}`, "error");
  }
}

async function deleteFounderQuestion(id) {
  if (state.role !== "admin" || !state.user?.uid) {
    return showToast("Only admins can delete founder questions.", "error");
  }
  const item = state.founderQuestions.find((question) => question.id === id);
  if (!item) return showToast("This founder question is no longer available. Refresh the page.", "error");
  const status = item.status === "answered" ? "answered" : "unanswered";
  if (!window.confirm(`Delete this ${status} founder question from ${item.ownerName || "this member"}? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "founderQuestions", id));
    state.founderQuestions = state.founderQuestions.filter((question) => question.id !== id);
    renderFounderQuestions();
    showToast("Founder question deleted.");
  } catch (error) {
    showToast(`The founder question could not be deleted: ${firebaseError(error)}`, "error");
  }
}

function inboxNotificationData(type, title, message, extra = {}) {
  return {
    type, title: String(title || "").slice(0, 120), message: String(message || "").slice(0, 1500), actorUid: state.user?.uid || "",
    actorName: memberDisplayName(state.member, state.user),
    createdAt: serverTimestamp(), read: false, ...extra
  };
}

async function notifyInboxMembers(recipients, type, title, message, extra = {}, batchSize = 3, notificationKey = "") {
  const uniqueRecipients = [...new Map((recipients || [])
    .filter((member) => member?.uid && member.uid !== state.user?.uid)
    .map((member) => [member.uid, member])).values()];
  for (let offset = 0; offset < uniqueRecipients.length; offset += batchSize) {
    const batch = writeBatch(db);
    uniqueRecipients.slice(offset, offset + batchSize).forEach((recipient) => {
      const notificationRef = notificationKey
        ? doc(db, "teamMembers", recipient.uid, "notifications", notificationKey)
        : doc(collection(db, "teamMembers", recipient.uid, "notifications"));
      const recipientExtra = typeof extra === "function" ? extra(recipient) : extra;
      batch.set(notificationRef, inboxNotificationData(type, title.slice(0, 120), message.slice(0, 1500), recipientExtra));
    });
    await batch.commit();
  }
  return uniqueRecipients.length;
}

function renderMemberInbox(items) {
  const list = $("memberInboxList") || $("askerInboxList");
  if (!list) return;
  const panel = $("memberInboxPanel") || $("askerInboxPanel");
  if (page !== "admin") panel?.classList.remove("hidden");
  personalPlanner?.refreshOverview();
  const unread = items.filter((item) => !item.read).length;
  const count = $("memberInboxCount") || $("askerInboxCount");
  if (count) count.textContent = unread ? `${unread} new` : `${items.length} messages`;
  const clearButton = $("clearMemberInboxBtn");
  if (clearButton) clearButton.disabled = clearButton.dataset.clearing === "true";
  list.innerHTML = items.length ? items.map((item) => `
    <article class="inbox-message ${item.read ? "is-read" : "is-unread"}">
      <div class="inbox-message-top"><strong>${escapeHtml(item.title || "NAWRAS update")}</strong><time>${escapeHtml(formatDate(item.createdAt))}</time></div>
      <p>${escapeHtml(item.message || "")}</p>
       ${item.type === "founder_answer" ? `<div class="founder-inbox-answer">${item.founderQuestion ? `<div class="founder-inbox-question"><span>Your question</span><p>${escapeHtml(item.founderQuestion)}</p>${renderLinkButtons(item.founderQuestionLinks)}</div>` : ""}<div class="founder-inbox-reply"><span>Reply from the founders</span><p>${escapeHtml(item.founderAnswer || "")}</p>${renderLinkButtons(item.founderAnswerLinks)}</div></div><a class="btn btn-primary btn-compact" href="admin.html?view=ask-founder">Open Ask Founder ↗</a>` : ""}
       ${item.type === "cross_team_work" && item.workflowId ? `<a class="btn btn-primary btn-compact" href="admin.html?view=cross-team-work&amp;workflow=${encodeURIComponent(item.workflowId)}">Open Cross-Team Work ↗</a>` : ""}
      ${item.actorName ? `<small>From ${escapeHtml(item.actorName)}</small>` : ""}
      ${item.type === "form_available" && item.formId ? `<a class="btn btn-outline btn-compact inbox-open-form" href="${escapeAttr(formShareUrl(item.formId))}">Open form ↗</a>` : ""}
      ${item.type === "form_response" ? `<a class="btn btn-outline btn-compact" href="admin.html?view=responses">View form submissions ↗</a>` : ""}
      ${item.type === "question_received" ? `<a class="btn btn-outline btn-compact" href="admin.html?view=questions">Open questions ↗</a>` : ""}
      ${item.type === "chat_message" ? `<a class="btn btn-outline btn-compact" href="admin.html?view=chat">Open leader chat ↗</a>` : ""}
      ${item.type === "technical_material" && item.technicalMaterialId ? `<a class="btn btn-outline btn-compact inbox-open-technical-material" href="admin.html?technicalMaterial=${encodeURIComponent(item.technicalMaterialId)}">Open Technical materials ↗</a>` : ""}
      ${item.type === "role_resource" && ASSIGNABLE_DASHBOARD_ROLES.includes(item.roleResourceRole) ? `<a class="btn btn-outline btn-compact" href="admin.html?view=resources&amp;role=${encodeURIComponent(item.roleResourceRole)}">Open team resources ↗</a>` : ""}
      ${item.type === "session_available" && item.sessionId ? `<a class="btn btn-outline btn-compact" href="nawras-online.html?session=${encodeURIComponent(item.sessionId)}">Open session ↗</a>` : ""}
      ${item.type === "academy_calendar_event" ? `<a class="btn btn-outline btn-compact" href="admin.html?view=calendar">Open my calendar ↗</a>` : ""}
      ${item.type === "course_update" ? `<a class="btn btn-outline btn-compact" href="admin.html?view=my-courses">Open my courses ↗</a>` : ""}
      ${["task_available", "task_submitted", "task_review"].includes(item.type) ? `<a class="btn btn-outline btn-compact" href="admin.html?view=${state.member?.teamLeadRoles?.includes(item.taskRole) ? "managed-tasks" : "tasks"}${ASSIGNABLE_DASHBOARD_ROLES.includes(item.taskRole) ? `&amp;role=${encodeURIComponent(item.taskRole)}` : ""}">Open tasks ↗</a>` : ""}
      ${item.type === "dashboard_access" ? `<a class="btn btn-outline btn-compact" href="admin.html">Open dashboard ↗</a>` : ""}
      ${["ratings_update", "ratings_reset"].includes(item.type) ? `<a class="btn btn-outline btn-compact inbox-open-ratings" href="admin.html?rating=mine">View my rating sheet ↗</a>` : ""}
      ${item.read ? "" : `<button class="text-button inbox-mark-read" type="button" data-inbox-read="${escapeAttr(item.id)}">Mark as read</button>`}
    </article>`).join("") : `<div class="empty-state">Nothing here yet. Answers and team updates will appear in this inbox.</div>`;
  list.querySelectorAll("[data-inbox-read]").forEach((button) => button.addEventListener("click", async () => {
    if (!state.user?.uid) return;
    try {
      await updateDoc(doc(db, "teamMembers", state.user.uid, "notifications", button.dataset.inboxRead), { read: true });
    } catch (error) {
      showToast(firebaseError(error), "error");
    }
  }));
}

async function filterInboxSessionNotices(items, uid, generation) {
  if (state.inboxSessionAccessUid !== uid) {
    state.inboxSessionAccessUid = uid;
    state.inboxSessionAccess = new Map();
  }
  const accessCache = state.inboxSessionAccess;
  const memberAtStart = state.member;
  const sessionNoticeIds = [...new Set(items
    .filter((item) => ["session_available", "session_cancelled", "attendance_update"].includes(item.type))
    .map((item) => item.sessionId).filter(Boolean))];
  for (let offset = 0; offset < sessionNoticeIds.length; offset += 20) {
    await Promise.all(sessionNoticeIds.slice(offset, offset + 20).map(async (sessionId) => {
      if (accessCache.has(sessionId)) return;
      let allowed = false;
      try {
        const snapshot = await getDoc(doc(db, "nawrasOnlineSessions", sessionId));
        allowed = snapshot.exists() && memberAtStart?.uid === uid
          && (memberAtStart.role === "admin"
            || isSessionForMember({ ...snapshot.data(), status: "scheduled" }, memberAtStart));
      } catch (_) {
        // A denied/missing room must not leave its title or date visible in the inbox.
      }
      accessCache.set(sessionId, allowed);
    }));
    if (state.inboxFilterGeneration !== generation || state.user?.uid !== uid) return null;
  }
  return items.filter((item) => !["session_available", "session_cancelled", "attendance_update"].includes(item.type)
    || (item.sessionId && accessCache.get(item.sessionId) === true));
}

async function loadMemberInbox(uid) {
  if (!uid) return;
  if (state.inboxUnsubscribe) state.inboxUnsubscribe();
  const generation = ++state.inboxFilterGeneration;
  let snapshotRevision = 0;
  try {
    const inboxQuery = query(collection(db, "teamMembers", uid, "notifications"), orderBy("createdAt", "desc"));
    state.inboxUnsubscribe = onSnapshot(inboxQuery, (snapshot) => {
      const revision = ++snapshotRevision;
      const messages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      void filterInboxSessionNotices(messages, uid, generation).then((visible) => {
        if (!visible || revision !== snapshotRevision || generation !== state.inboxFilterGeneration || state.user?.uid !== uid) return;
        state.inboxMessages = visible;
        renderMemberInbox(state.inboxMessages);
      });
    }, (error) => {
      const list = $("memberInboxList") || $("askerInboxList");
      if (list) list.innerHTML = `<div class="empty-state">Inbox could not be loaded. Check that the latest Firestore rules are deployed.</div>`;
      if (error?.code !== "permission-denied") showToast(firebaseError(error), "error");
    });
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function clearMemberInbox() {
  const uid = state.user?.uid;
  const messages = state.inboxMessages.slice();
  const button = $("clearMemberInboxBtn");
  const status = $("clearMemberInboxStatus");
  if (!uid) {
    if (status) status.textContent = "Sign in to clear your inbox.";
    return;
  }
  if (!messages.length) {
    if (status) status.textContent = "Your inbox is already empty.";
    return;
  }
  if (button) {
    button.disabled = true;
    button.dataset.clearing = "true";
    button.textContent = "Clearing…";
  }
  if (status) status.textContent = `Clearing ${messages.length} message${messages.length === 1 ? "" : "s"}…`;
  try {
    for (let offset = 0; offset < messages.length; offset += 450) {
      const batch = writeBatch(db);
      messages.slice(offset, offset + 450).forEach((message) => {
        batch.delete(doc(db, "teamMembers", uid, "notifications", message.id));
      });
      await batch.commit();
    }
    if (status) status.textContent = "Inbox cleared.";
    showToast("Your inbox has been cleared.");
  } catch (error) {
    const message = error?.code === "permission-denied" || error?.code === "firestore/permission-denied"
      ? "Permission denied. Deploy the updated Firestore rules, then try again."
      : `Could not clear your entire inbox: ${firebaseError(error)}`;
    if (status) status.textContent = message;
    showToast(message, "error");
  } finally {
    if (button) {
      button.dataset.clearing = "false";
      button.textContent = "Clear inbox";
      button.disabled = state.inboxMessages.length === 0;
    }
  }
}

const TASK_ROLE_ORDER = ["admin", "user", "leaders", "public", "tech", "social", "designers", "content", "event"];
const POSITION_LEADER_TASK_AUDIENCE = "position_leaders";
const TASK_MODE_LABELS = {
  all: "Compulsory for everyone",
  first: "First submission wins",
  free: "Open to the team"
};

function taskLeaderUniversityTag(member = state.member) {
  const explicit = String(member?.leadingUniversityTag || "").trim();
  if (universityByTag(explicit)) return explicit;
  const assigned = String(member?.universityTag || "").trim();
  return universityByTag(assigned) ? assigned : "";
}

function canManageTasksForRole(roleKey) {
  return state.role === "admin"
    || (roleKey !== POSITION_LEADER_TASK_AUDIENCE && currentTeamLeadRoles().includes(roleKey))
    || (roleKey !== POSITION_LEADER_TASK_AUDIENCE && hasDashboardAccess("tasksManage")
      && (roleKey === state.role || currentTeamLeadRoles().includes(roleKey)));
}

function canAssignTasksAcrossRoles() {
  return state.role === "admin" || state.role === "leaders" || hasDashboardAccess("tasksManage");
}

function canCreateTaskForRole(roleKey) {
  if (state.role === "admin") return true;
  if (state.role === "leaders") {
    const universityScope = Boolean(taskLeaderUniversityTag())
      && ![POSITION_LEADER_TASK_AUDIENCE, "admin"].includes(roleKey)
      && ASSIGNABLE_DASHBOARD_ROLES.includes(roleKey);
    const appointedPositionScope = currentTeamLeadRoles().includes(roleKey)
      && ![POSITION_LEADER_TASK_AUDIENCE, "admin"].includes(roleKey);
    return universityScope || appointedPositionScope;
  }
  if (hasDashboardAccess("tasksManage") && (roleKey === state.role || currentTeamLeadRoles().includes(roleKey))) {
    return roleKey !== POSITION_LEADER_TASK_AUDIENCE;
  }
  return currentTeamLeadRoles().includes(roleKey);
}

function canCreateAnyTask() {
  if (state.role === "admin" || state.role === "leaders") return true;
  return currentTeamLeadRoles().some((roleKey) => canCreateTaskForRole(roleKey))
    || (hasDashboardAccess("tasksManage") && canCreateTaskForRole(state.role));
}

function canManageTask(task) {
  return Boolean(task && (
    state.role === "admin"
    || (canManageTasksForRole(task.targetRole)
      && (state.role !== "leaders"
        || !taskLeaderUniversityTag()
        || String(task.targetUniversityTag || "") === taskLeaderUniversityTag()))
    || (state.role === "leaders"
      && task.createdBy === state.user?.uid
      && task.targetUniversityTag === taskLeaderUniversityTag())
  ));
}

function taskMatchesAudience(task, member = state.member, uid = state.user?.uid) {
  if (!task || !member || !uid || member.active === false) return false;
  const taskRole = task.targetRole;
  const roleMatches = taskRole === POSITION_LEADER_TASK_AUDIENCE
    ? isPositionLeader(member)
    : member.role === taskRole
      || (member.role === "admin" && (
        taskRole === "admin" || adminTeamAssignment(member)?.role === taskRole
      ));
  const universityTag = String(task.targetUniversityTag || "");
  const universityMatches = !universityTag || member.universityTag === universityTag;
  const assigned = Array.isArray(task.assignedMemberUids) ? task.assignedMemberUids : [];
  return roleMatches && universityMatches && (!assigned.length || assigned.includes(uid));
}

function taskUniversityScopeForCurrentUser() {
  return state.role === "leaders" ? taskLeaderUniversityTag() : "";
}

function taskMemberChoices(roleKey, universityTag) {
  return state.teamMembers
    .filter((member) => member.active !== false)
    .filter((member) => roleKey === POSITION_LEADER_TASK_AUDIENCE
      ? isPositionLeader(member)
      : member.role === roleKey
        || (member.role === "admin" && (roleKey === "admin" || adminTeamAssignment(member)?.role === roleKey)))
    .filter((member) => !universityTag || member.universityTag === universityTag)
    .sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
}

function refreshTaskMemberSelector(selectedUids = null) {
  const roleKey = $("taskTargetRole")?.value || "";
  const universityTag = $("taskTargetUniversity")?.value || "";
  const select = $("taskAssignedMembers");
  const search = $("taskMemberSearch");
  if (!select) return;
  if (selectedUids !== null) taskSelectedMemberUids = new Set(selectedUids);
  const selected = [...taskSelectedMemberUids];
  const term = String(search?.value || "").trim().toLocaleLowerCase();
  const members = taskMemberChoices(roleKey, universityTag).filter((member) =>
    !term || memberDisplayName(member).toLocaleLowerCase().includes(term)
      || String(member.email || "").toLocaleLowerCase().includes(term));
  select.innerHTML = members.length
    ? members.map((member) => `<label class="task-assignee-option"><input type="checkbox" value="${escapeAttr(member.uid)}" ${selected.includes(member.uid) ? "checked" : ""}><span><strong>${escapeHtml(memberDisplayName(member))}</strong><small>${escapeHtml(ROLE_CONFIG[member.role]?.label || member.role)}${member.universityTag ? ` · ${escapeHtml(universityLabel(member.universityTag))}` : ""}</small></span></label>`).join("")
    : `<p class="task-assignee-empty">No eligible people found for this team and university.</p>`;
}

function taskDashboardRole() {
  const activeRole = state.activeDashboardRole;
  if (canCreateTaskForRole(activeRole)) return activeRole;
  if (state.role === "leaders" && canCreateTaskForRole("leaders")) return "leaders";
  return currentTeamLeadRoles().find((role) => canCreateTaskForRole(role)) || state.role;
}

function taskTargetRole(task) {
  if (task?.targetRole === POSITION_LEADER_TASK_AUDIENCE) return "Position leaders";
  if (task?.targetRole === "leaders") return "Leaders account role";
  return ROLE_CONFIG[task?.targetRole]?.label || task?.targetRole || "Team";
}

function taskTargetLabel(task) {
  const label = taskTargetRole(task);
  return ["leaders", POSITION_LEADER_TASK_AUDIENCE].includes(task?.targetRole) ? label : `${label} team`;
}

function isPositionLeader(member) {
  const roles = Array.isArray(member?.teamLeadRoles) ? member.teamLeadRoles : [];
  return roles.some((role) => ASSIGNABLE_DASHBOARD_ROLES.includes(role))
    || adminTeamAssignment(member)?.position === "leader";
}

function canSubmitTaskAsCurrentUser(task) {
  return taskMatchesAudience(task);
}

function taskModeLabel(mode) {
  return TASK_MODE_LABELS[mode] || "Open to the team";
}

async function loadTasks() {
  if (!state.isTeam || !refs.tasksList) return;
  try {
    const base = collection(db, "tasks");
    let snapshots;
    let migratedTaskFields = {};
    if (state.role === "admin") {
      try {
        snapshots = [await getDocs(query(base, orderBy("createdAt", "desc")))];
      } catch (_) {
        snapshots = [await getDocs(base)];
      }
      migratedTaskFields = await migrateLegacyTaskAudiences(snapshots.flatMap((snapshot) => snapshot.docs));
    } else {
      const taskQueries = [];
      const personalRoles = [...new Set([
        state.role,
        ...(isPositionLeader(state.member) ? [POSITION_LEADER_TASK_AUDIENCE] : [])
      ])];
      const universityTags = [...new Set([
        "", String(state.member?.universityTag || ""),
        ...(state.role === "leaders" ? [taskLeaderUniversityTag()] : [])
      ])];
      for (const roleKey of personalRoles) {
        for (const universityTag of universityTags) {
          for (const audienceFilter of [
            [{ field: "audienceMode", op: "==", value: "all" }]
          ]) {
            taskQueries.push(getDocs(query(base,
              where("targetRole", "==", roleKey),
              where("targetUniversityTag", "==", universityTag),
              ...audienceFilter.map((filter) => where(filter.field, filter.op, filter.value))
            )));
          }
        }
      }
      for (const roleKey of currentTeamLeadRoles()) {
        const filters = [where("targetRole", "==", roleKey)];
        const leaderUniversity = state.role === "leaders"
          ? taskLeaderUniversityTag()
          : "";
        if (leaderUniversity) filters.push(where("targetUniversityTag", "==", leaderUniversity));
        taskQueries.push(getDocs(query(base, ...filters)));
      }
      if (state.role === "leaders") {
        const createdTasksQuery = query(base,
          where("createdBy", "==", state.user.uid),
          where("targetUniversityTag", "==", taskLeaderUniversityTag()));
        taskQueries.push(getDocs(createdTasksQuery));
      }
      snapshots = await Promise.all(taskQueries);
      const assignmentSnapshot = await getDocs(collection(db, "teamMembers", state.user.uid, "taskAssignments"));
      const individuallyAssignedTasks = await Promise.all(assignmentSnapshot.docs.map(async (assignment) => {
        try {
          const taskSnapshot = await getDoc(doc(db, "tasks", assignment.id));
          return taskSnapshot.exists() ? { id: taskSnapshot.id, data: () => taskSnapshot.data() } : null;
        } catch (_) { return null; }
      }));
      snapshots.push({ docs: individuallyAssignedTasks.filter(Boolean) });
    }
    const taskById = new Map();
    snapshots.flatMap((snapshot) => snapshot.docs).forEach((item) => taskById.set(item.id, {
      id: item.id, ...item.data(), ...(migratedTaskFields[item.id] || {})
    }));
    state.tasks = [...taskById.values()].sort(sortByCreatedDesc);
    const tasksForMe = state.tasks.filter(canSubmitTaskAsCurrentUser);
    const submissions = await Promise.all(tasksForMe.map(async (task) => {
      const submission = await getDoc(doc(db, "tasks", task.id, "submissions", state.user.uid));
      return [task.id, submission.exists() ? { id: submission.id, ...submission.data() } : null];
    }));
    state.taskSubmissions = Object.fromEntries(submissions);
    renderTasks();
  } catch (error) {
    refs.tasksList.innerHTML = `<div class="empty-state">Tasks could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

async function migrateLegacyTaskAudiences(taskDocs) {
  const legacyDocs = taskDocs.filter((item) => {
    const data = item.data();
    return !Object.prototype.hasOwnProperty.call(data, "targetUniversityTag")
      || !Object.prototype.hasOwnProperty.call(data, "assignedMemberUids")
      || !Object.prototype.hasOwnProperty.call(data, "audienceMode");
  });
  if (!legacyDocs.length) return {};
  const creatorUids = [...new Set(legacyDocs.map((item) => item.data().createdBy).filter(Boolean))];
  const creatorProfiles = new Map();
  await Promise.all(creatorUids.map(async (uid) => {
    try {
      const profile = await getDoc(doc(db, "teamMembers", uid));
      if (profile.exists()) creatorProfiles.set(uid, profile.data());
    } catch (_) {}
  }));
  const migrated = {};
  for (let offset = 0; offset < legacyDocs.length; offset += 10) {
    const batch = writeBatch(db);
    const chunk = legacyDocs.slice(offset, offset + 10);
    for (const item of chunk) {
      const data = item.data();
      const assignedMemberUids = Array.isArray(data.assignedMemberUids) ? data.assignedMemberUids : [];
      const creator = creatorProfiles.get(data.createdBy);
      const targetUniversityTag = Object.prototype.hasOwnProperty.call(data, "targetUniversityTag")
        ? data.targetUniversityTag
        : creator?.role === "leaders" ? taskLeaderUniversityTag(creator) : "";
      const values = {
        targetUniversityTag,
        assignedMemberUids,
        audienceMode: assignedMemberUids.length ? "selected" : "all",
        updatedAt: serverTimestamp()
      };
      migrated[item.id] = { ...values, updatedAt: data.updatedAt };
      batch.update(doc(db, "tasks", item.id), values);
    }
    await batch.commit();
  }
  for (const item of legacyDocs) {
    const assigned = migrated[item.id]?.assignedMemberUids || [];
    if (assigned.length) await syncTaskRecipientAssignments(item.id, [], assigned);
  }
  return migrated;
}

function renderTasks() {
  personalPlanner?.refreshOverview();
  if (!refs.tasksList) return;
  const canViewAllTasks = state.role === "admin";
  const isAdmin = state.role === "admin";
  const viewRole = taskDashboardRole();
  const isRoleLeader = state.role !== "admin" && (canManageTasksForRole(viewRole) || state.role === "leaders");
  const canManageCurrentTeam = canManageTasksForRole(viewRole);
  const leaderNeedsAssignment = state.role === "leaders"
    && !taskLeaderUniversityTag()
    && !currentTeamLeadRoles().length;
  const teamLabel = ROLE_CONFIG[viewRole]?.label || ROLE_CONFIG[state.role]?.label || "Team";
  const isUniversityLeaderBoard = state.role === "leaders" && viewRole === "leaders";
  if (refs.tasksPanelTitle) refs.tasksPanelTitle.textContent = isAdmin ? "Task command center" : isUniversityLeaderBoard ? "Leaders task board" : isRoleLeader ? `${teamLabel} team tasks` : `${ROLE_CONFIG[state.role]?.label || "Team"} tasks`;
  if (refs.tasksPanelHint) refs.tasksPanelHint.textContent = isAdmin
    ? "Assign work, set XP, and review submissions."
    : leaderNeedsAssignment
      ? "An admin must assign your university or a position team before you can create or manage tasks."
    : isUniversityLeaderBoard
      ? "Create role-based tasks and review submissions for tasks you assigned."
    : isRoleLeader
      ? `Assign tasks to ${teamLabel}, review submissions, and award XP.`
      : "Complete a task to earn its XP reward.";
  if ($("addTaskBtn")) {
    $("addTaskBtn").classList.toggle("hidden", !canCreateAnyTask());
    $("addTaskBtn").disabled = leaderNeedsAssignment;
    $("addTaskBtn").title = leaderNeedsAssignment
      ? "An admin must assign you a university or position team first."
      : "";
  }

  const ownTasks = state.tasks.filter((task) => canSubmitTaskAsCurrentUser(task)
    && (task.status === "open" || state.taskSubmissions[task.id]));
  const managedTasks = state.tasks.filter((task) => canManageTask(task)
    && (canViewAllTasks || task.targetRole === viewRole || (state.role === "leaders" && task.createdBy === state.user?.uid)));
  if (!state.tasks.length || (!canViewAllTasks && !managedTasks.length && !ownTasks.length)) {
    refs.tasksList.innerHTML = `<div class="empty-state">${canCreateTaskForRole(viewRole) ? `No ${escapeHtml(teamLabel)} tasks yet. Assign the first one above.` : "No tasks have been assigned to your team yet."}</div>`;
    if (refs.taskSubmissionsViewer) refs.taskSubmissionsViewer.classList.add("hidden");
    return;
  }
  if (canViewAllTasks) {
    refs.tasksList.innerHTML = `${ownTaskGroupsMarkup(ownTasks)}<section class="admin-task-work-section"><div class="admin-task-section-heading"><div><span class="panel-kicker">Management</span><h3>Task command center</h3></div><span class="panel-hint">Assign work, set XP, and review submissions.</span></div><div class="task-list">${state.tasks.map(adminTaskCard).join("")}</div></section>`;
  } else if (isRoleLeader) {
    refs.tasksList.innerHTML = `${ownTaskGroupsMarkup(ownTasks)}<section class="admin-task-work-section"><div class="admin-task-section-heading"><div><span class="panel-kicker">Team management</span><h3>${escapeHtml(teamLabel)} team tasks</h3></div><span class="panel-hint">Review member work and award XP when it meets the task requirements.</span></div>${managedTasks.length ? `<div class="task-list">${managedTasks.map(adminTaskCard).join("")}</div>` : `<div class="empty-state">No tasks have been assigned to this team yet.</div>`}</section>`;
  } else {
    refs.tasksList.innerHTML = ownTaskGroupsMarkup(ownTasks);
  }
  hydrateTaskCoverImages(refs.tasksList);
}

function ownTaskGroupsMarkup(tasks) {
  if (!tasks.length) return `<div class="empty-state">No open tasks are assigned to you right now.</div>`;
  const groups = [
    { key: POSITION_LEADER_TASK_AUDIENCE, title: "Position-leader assignments", hint: "Assigned by admins to appointed team leaders. Admins review these submissions." },
    { key: "leaders", title: "Leaders-role assignments", hint: "For the Leaders account-role team, separate from team-leader appointments." },
    { key: "other", title: "Your role tasks", hint: "Tasks assigned to your account role or your assigned Admin team." }
  ];
  return groups.map((group) => {
    const items = tasks.filter((task) => group.key === "other"
      ? !["leaders", POSITION_LEADER_TASK_AUDIENCE].includes(task.targetRole)
      : task.targetRole === group.key);
    return items.length ? `<section class="admin-task-work-section"><div class="admin-task-section-heading"><div><span class="panel-kicker">Your work</span><h3>${group.title}</h3></div><span class="panel-hint">${group.hint}</span></div><div class="task-list">${items.map(taskSummaryCard).join("")}</div></section>` : "";
  }).join("");
}

function adminTaskCard(task) {
  return taskSummaryCard(task);
}

function taskBriefExcerpt(description, maxLength = 130) {
  const brief = String(description || "").replace(/\s+/g, " ").trim();
  if (!brief) return "Open the task to see the full instructions.";
  if (brief.length <= maxLength) return brief;
  const shortened = brief.slice(0, maxLength);
  const lastSpace = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, lastSpace > maxLength * 0.65 ? lastSpace : maxLength).trimEnd()}…`;
}

function taskSummaryCard(task) {
  const submission = state.taskSubmissions[task.id];
  const submittedLabel = submission
    ? (submission.status === "approved" ? "Approved" : submission.status === "rejected" ? "Needs changes" : "Submitted")
    : task.status === "open" ? "Open" : "Closed";
  const submittedClass = submission ? "is-submitted" : task.status === "open" ? "is-open" : "is-closed";
  const taskMeta = [
    escapeHtml(taskTargetLabel(task)),
    escapeHtml(taskModeLabel(task.mode)),
    task.dueAt ? `Due ${escapeHtml(formatDate(task.dueAt))}` : ""
  ].filter(Boolean);
  return `<article class="content-card task-preview-card" data-open-task-card="${escapeAttr(task.id)}" tabindex="0" role="button" aria-label="${escapeAttr(`Open task: ${task.title || ""}`)}">
    ${taskCoverMarkup(task)}
    <div class="content-card-body">
      <div class="task-preview-top"><span class="task-status ${submittedClass}">${escapeHtml(submittedLabel)}</span><strong class="task-preview-xp">+${Number(task.xp) || 0} XP</strong></div>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="task-preview-excerpt">${escapeHtml(taskBriefExcerpt(task.description))}</p>
      ${taskAssignedByMarkup(task)}
      <div class="task-preview-meta">${taskMeta.map((item) => `<span>${item}</span>`).join("")}</div>
      <div class="card-footer task-preview-footer"><span class="muted">Open task details</span><span class="card-arrow" aria-hidden="true">${materialIcon("arrow_forward")}</span></div>
    </div>
  </article>`;
}

function memberTaskSubmissionMarkup(task) {
  const submission = state.taskSubmissions[task.id];
  const locked = task.status !== "open";
  let body;
  if (submission) {
    const reviewStatus = submission.status || (Number(submission.xpAwarded) > 0 ? "approved" : "pending");
    const isApproved = reviewStatus === "approved";
    const isRejected = reviewStatus === "rejected";
    body = `<div class="task-complete ${isRejected ? "task-rejected" : isApproved ? "" : "task-pending"}"><span class="task-complete-mark">${materialIcon(isApproved ? "task_alt" : isRejected ? "error" : "hourglass_top")}</span><div><strong>${isApproved ? "Approved" : isRejected ? "Needs changes" : "Awaiting review"}</strong><p>${escapeHtml(formatDate(submission.submittedAt))} · ${isApproved ? `You earned +${Number(submission.xpAwarded) || 0} XP.` : isRejected ? "No XP was awarded for this submission." : "The task stays open while a team lead or admin reviews submissions."}</p></div></div>`;
  } else if (locked) {
    body = `<div class="task-locked"><span>◌</span><div><strong>Task closed</strong><p>This task is no longer accepting submissions.</p></div></div>`;
  } else if (taskHasGame(task)) {
    body = `<div class="task-game-launch"><div><strong>Interactive task</strong><p>Open the page and finish it. Your note and links below are sent with your result.</p></div><button type="button" class="btn btn-primary btn-compact" data-play-task="${escapeAttr(task.id)}">Start task <span>→</span></button></div><form class="task-submit-form task-game-submit-form" data-submit-task="${escapeAttr(task.id)}"><label>Your submission<textarea id="task-text-${escapeAttr(task.id)}" rows="3" maxlength="3000" placeholder="Write a note about your work (optional if you add a link)…"></textarea></label>${linkEditorMarkup("task", task.id, "Add a link", "Add up to 3 labeled links, e.g. your Drive file, design, or repository.")}<button class="btn btn-secondary btn-compact" type="submit">Submit task <span>→</span></button></form>`;
  } else {
    body = `<form class="task-submit-form" data-submit-task="${escapeAttr(task.id)}"><label>Your submission<textarea id="task-text-${escapeAttr(task.id)}" rows="4" maxlength="3000" placeholder="Describe what you completed…" required></textarea></label>${linkEditorMarkup("task", task.id, "Add supporting link", "Attach up to 3 labeled links to your submission.")}<button class="btn btn-primary btn-compact" type="submit">Submit task <span>→</span></button></form>`;
  }
  return body;
}

function taskCoverMarkup(task, size = "card") {
  const imageUrl = normalizePhotoUrl(task?.imageUrl);
  const driveFileId = String(task?.coverDriveFileId || "");
  const hasCover = Boolean(imageUrl || driveFileId);
  const className = size === "detail" ? "task-details-cover" : "content-card-media task-preview-media";
  return `<div class="${className}${hasCover ? "" : " is-placeholder"}"><div class="image-placeholder task-cover-placeholder" aria-hidden="true">${materialIcon("task_alt")}</div>${hasCover ? `<img class="task-cover-image" data-task-cover-image data-task-id="${escapeAttr(task.id)}" data-task-cover-file="${escapeAttr(driveFileId)}" data-task-cover-url="${escapeAttr(imageUrl)}" alt="${escapeAttr(task.title || "Task cover")}" loading="lazy" referrerpolicy="no-referrer" hidden>` : ""}</div>`;
}

function taskAssignedByMarkup(task) {
  const member = state.teamMembers.find((item) => item.uid === task?.createdBy) || {};
  const name = String(task?.createdByName || (member.uid ? memberDisplayName(member) : "NAWRAS EDU team")).trim();
  const creatorProfile = {
    ...member,
    uid: task?.createdBy || member.uid || "",
    displayName: name,
    photoURL: task?.createdByPhotoURL || member.photoURL || ""
  };
  return `<div class="task-assigned-by">${profileAvatarMarkup(creatorProfile, "small")}<span class="task-assigned-by-copy"><small>Assigned by</small><strong>${escapeHtml(name)}</strong></span></div>`;
}

function hydrateTaskCoverImages(root) {
  root?.querySelectorAll("img[data-task-cover-image]").forEach((image) => {
    const showImage = () => {
      image.hidden = false;
      image.closest(".task-preview-media, .task-details-cover")?.classList.add("has-photo");
    };
    image.addEventListener("load", showImage, { once: true });
    image.addEventListener("error", () => { image.hidden = true; }, { once: true });
    const externalUrl = normalizePhotoUrl(image.dataset.taskCoverUrl || "");
    if (externalUrl) {
      image.src = externalUrl;
      return;
    }
    const taskId = image.dataset.taskId;
    const fileId = image.dataset.taskCoverFile;
    if (!taskId || !fileId) return;
    const cacheKey = `${taskId}:${fileId}`;
    const cached = taskCoverPreviewCache.get(cacheKey);
    if (cached?.url && cached.expiresAt > Date.now()) {
      image.src = cached.url;
      return;
    }
    if (cached?.promise && cached.expiresAt > Date.now()) {
      cached.promise.then((url) => { if (url && image.isConnected) image.src = url; });
      return;
    }
    const request = requestDrivePreviewTicket(auth, "taskCover", taskId, fileId)
      .then((ticket) => {
        taskCoverPreviewCache.set(cacheKey, { url: ticket.url, expiresAt: Date.now() + 50 * 60 * 1000 });
        return ticket.url;
      })
      .catch(() => {
        taskCoverPreviewCache.delete(cacheKey);
        return "";
      });
    taskCoverPreviewCache.set(cacheKey, { promise: request, expiresAt: Date.now() + 50 * 60 * 1000 });
    request.then((url) => { if (url && image.isConnected) image.src = url; });
  });
}

function ensureTaskDetailsModal() {
  let modal = $("taskDetailsModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "taskDetailsModal";
    modal.className = "modal hidden task-preview-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="modal-backdrop" data-close-modal="taskDetailsModal"></div><div class="modal-card task-details-modal"><button class="modal-close" type="button" data-close-modal="taskDetailsModal" aria-label="Close task details">×</button><div id="taskDetailsContent"></div></div>`;
    document.body.appendChild(modal);
  }
  return { modal, details: $("taskDetailsContent") };
}

function openTaskDetails(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const { modal, details } = ensureTaskDetailsModal();
  if (!details) return;
  const canManage = canManageTask(task);
  const canSubmit = canSubmitTaskAsCurrentUser(task);
  const hasSubmission = Boolean(state.taskSubmissions[task.id]);
  const submitCta = canSubmit && task.status === "open" && !hasSubmission
    ? taskHasGame(task)
      ? `<button type="button" class="btn btn-primary task-details-primary-action" data-play-task="${escapeAttr(task.id)}">${materialIcon("play_arrow")} Start task</button>`
      : `<button type="button" class="btn btn-primary task-details-primary-action" data-jump-submit>${materialIcon("send")} Submit task</button>`
    : "";
  const managerActions = canManage ? `
    <div class="task-details-actions">
      <button type="button" class="btn btn-primary" data-edit-task="${escapeAttr(task.id)}">${materialIcon("edit")} Edit task</button>
      ${taskHasGame(task) ? `<button type="button" class="btn btn-outline" data-preview-task="${escapeAttr(task.id)}">${materialIcon("visibility")} Preview activity</button>` : ""}
      <button type="button" class="btn btn-secondary" data-view-task="${escapeAttr(task.id)}">${materialIcon("fact_check")} View submissions <span>${Number(task.submissionCount) || 0}</span></button>
      ${task.status === "open" ? `<button type="button" class="btn btn-outline" data-close-task="${escapeAttr(task.id)}">${materialIcon("lock")} Close task</button>` : ""}
      <button type="button" class="btn btn-danger" data-delete-task="${escapeAttr(task.id)}">${materialIcon("delete")} Delete task</button>
    </div>` : "";
  const memberSubmission = canSubmit ? memberTaskSubmissionMarkup(task) : "";
  const assets = taskAssetsMarkup(task);
  const detailsMeta = [
    `<span>${escapeHtml(taskTargetLabel(task))}</span>`,
    `<span>${escapeHtml(taskModeLabel(task.mode))}</span>`,
    `<span>Up to +${Number(task.xp) || 0} XP</span>`,
    `<span>${Number(task.submissionCount) || 0} submission${Number(task.submissionCount) === 1 ? "" : "s"}</span>`,
    task.dueAt ? `<span>Due ${escapeHtml(formatDate(task.dueAt))}</span>` : ""
  ].filter(Boolean).join("");
  details.innerHTML = `<div class="task-details-shell">
    <section class="task-details-hero">
      ${taskCoverMarkup(task, "detail")}
      <div class="task-details-intro">
        <div class="task-details-kickers"><span class="card-tag">${escapeHtml(taskTargetLabel(task))}</span><span class="task-status ${task.status === "open" ? "is-open" : "is-closed"}">${task.status === "open" ? "Open task" : "Closed task"}</span></div>
        <h2 id="taskDetailsTitle">${escapeHtml(task.title)}</h2>
        <div class="task-details-byline">${taskAssignedByMarkup(task)}</div>
        <div class="task-details-meta">${detailsMeta}</div>
        ${submitCta}
      </div>
    </section>
    <div class="task-details-content">
      <section class="task-details-section"><span class="panel-kicker">TASK BRIEF</span><h3>What to do</h3><p class="task-details-description">${escapeHtml(task.description || "No additional instructions were added.")}</p></section>
      ${assets ? `<section class="task-details-section"><span class="panel-kicker">ATTACHMENTS</span><h3>Task assets</h3>${assets}</section>` : `<section class="task-details-empty"><span class="task-details-empty-icon">${materialIcon("attach_file")}</span><div><strong>No extra assets</strong><p>There are no files or links attached to this task.</p></div></section>`}
      ${memberSubmission ? `<section class="task-details-section"><span class="panel-kicker">YOUR SUBMISSION</span><h3>Complete this task</h3>${memberSubmission}</section>` : ""}
      ${managerActions}
    </div>
  </div>`;
  modal.setAttribute("aria-labelledby", "taskDetailsTitle");
  const closeAnd = (callback) => {
    closeModal("taskDetailsModal");
    callback();
  };
  details.querySelector("[data-edit-task]")?.addEventListener("click", () => closeAnd(() => openTaskEditor(task.id)));
  details.querySelector("[data-view-task]")?.addEventListener("click", () => closeAnd(() => viewTaskSubmissions(task.id)));
  details.querySelector("[data-preview-task]")?.addEventListener("click", () => closeAnd(() => openTaskGame(task.id, true)));
  details.querySelectorAll("[data-play-task]").forEach((button) =>
    button.addEventListener("click", () => closeAnd(() => openTaskGame(task.id))));
  details.querySelector("[data-jump-submit]")?.addEventListener("click", () => {
    const form = details.querySelector("[data-submit-task]");
    form?.scrollIntoView({ behavior: "smooth", block: "center" });
    form?.querySelector("textarea")?.focus({ preventScroll: true });
  });
  details.querySelector("[data-close-task]")?.addEventListener("click", () => closeAnd(() => closeTask(task.id)));
  details.querySelector("[data-delete-task]")?.addEventListener("click", () => closeAnd(() => deleteTask(task.id)));
  details.querySelector("[data-submit-task]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitTask(task.id).then((submitted) => {
      if (submitted) closeModal("taskDetailsModal");
    });
  });
  bindLinkEditors(details);
  hydrateTaskCoverImages(details);
  openModal("taskDetailsModal");
}

const MAX_TASK_ASSETS = 6;
const MAX_TASK_GAME_HTML = 500000;
const TASK_GAME_MESSAGE_TYPE = "nawras-task-complete";
const taskGameState = { taskId: "", preview: false, submitting: false, finished: false, expectedOrigin: "" };

function taskHasGame(task) {
  return (task?.gameType === "html" && Boolean(task.gameHtml)) || (task?.gameType === "url" && Boolean(normalizeHttpUrl(task.gameUrl)));
}

function taskAssetsMarkup(task) {
  const assets = Array.isArray(task?.assets) ? task.assets.slice(0, MAX_TASK_ASSETS) : [];
  const items = assets.map((asset, index) => {
    const url = normalizeHttpUrl(asset?.url);
    if (!url) return "";
    const label = String(asset?.label || `Asset ${index + 1}`).trim();
    return `<a class="task-asset-chip" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer"><span class="task-asset-icon">${materialIcon(taskAssetIcon(url))}</span><span>${escapeHtml(label)}</span>${materialIcon("open_in_new")}</a>`;
  }).filter(Boolean);
  return items.length ? `<div class="task-assets"><span class="task-assets-label">Task assets</span><div class="task-assets-list">${items.join("")}</div></div>` : "";
}

function taskAssetIcon(url) {
  const path = url.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(path) || path.includes("i.ibb.co")) return "image";
  if (/\.pdf$/.test(path)) return "picture_as_pdf";
  if (/\.(mp4|mov|webm)$/.test(path) || /youtu\.?be/.test(path)) return "play_circle";
  if (/\.(zip|rar|7z)$/.test(path)) return "folder_zip";
  return "attach_file";
}

function taskGameResultMarkup(submission) {
  const result = submission?.gameResult;
  if (!result) return "";
  const hasScore = typeof result.score === "number";
  const scoreText = hasScore ? `${result.score}${typeof result.maxScore === "number" ? ` / ${result.maxScore}` : ""}` : "";
  return `<div class="task-game-result"><span class="task-assets-label">Interactive page result</span>${scoreText ? `<strong class="task-game-score">Score: ${escapeHtml(scoreText)}</strong>` : ""}${result.summary ? `<p>${escapeHtml(result.summary)}</p>` : ""}${result.details ? `<details><summary>Details</summary><pre>${escapeHtml(result.details)}</pre></details>` : ""}${result.completedAtClient ? `<small>Finished ${escapeHtml(new Date(result.completedAtClient).toLocaleString())}</small>` : ""}</div>`;
}

function toggleTaskGameFields() {
  const type = $("taskGameType")?.value || "none";
  $("taskGameUrlWrap")?.classList.toggle("hidden", type !== "url");
  $("taskGameHtmlWrap")?.classList.toggle("hidden", type !== "html");
}

function updateTaskGameHtmlSize() {
  const size = $("taskGameHtml")?.value.length || 0;
  if ($("taskGameHtmlSize")) $("taskGameHtmlSize").textContent = `${Math.ceil(size / 1000)} KB / ${MAX_TASK_GAME_HTML / 1000} KB`;
}

function setupTaskExtraFields() {
  if (!$("taskDueAt")) $("taskDescription")?.closest("label")?.insertAdjacentHTML("afterend",
    '<label>Deadline (optional)<input id="taskDueAt" type="datetime-local"><small>Times use your device timezone. Leave blank if there is no deadline.</small></label>');
  bindLinkEditors($("taskForm"));
  $("taskGameType")?.addEventListener("change", toggleTaskGameFields);
  $("taskGameHtml")?.addEventListener("input", updateTaskGameHtmlSize);
  $("taskGameFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_TASK_GAME_HTML) {
      event.target.value = "";
      return showToast("The HTML file must be under 500 KB. Host bigger games online and use the URL option.", "error");
    }
    $("taskGameHtml").value = await file.text();
    updateTaskGameHtmlSize();
    showToast(`Loaded ${file.name}.`);
  });
  $("taskGameSubmitBtn")?.addEventListener("click", () => {
    if (taskGameState.finished || taskGameState.submitting) return;
    if (!taskGameState.preview && !window.confirm("هل انتهيت من حل التاسك؟ سيتم إرساله للأدمن للمراجعة.")) return;
    submitTaskGameResult(sanitizeGameResult({ summary: "Marked as finished by the member" }));
  });
  $("taskGameFullscreenBtn")?.addEventListener("click", () => {
    const frame = $("taskGameFrame");
    if (frame?.requestFullscreen) frame.requestFullscreen().catch(() => showToast("Full screen is not available here.", "error"));
  });
  document.querySelectorAll('[data-close-modal="taskGameModal"]').forEach((button) => button.addEventListener("click", resetTaskGameFrame));
  window.addEventListener("message", handleTaskGameMessage);
}

function taskAssignmentLocked(task) {
  return Boolean(task && (Number(task.submissionCount) > 0 || task.claimedByUid || task.status !== "open"));
}

let taskImagePreviewUrl = "";
const taskCoverPreviewCache = new Map();

function previewTaskCoverSelection() {
  const file = $("taskImageFile")?.files?.[0];
  const preview = $("taskImagePreview");
  const image = preview?.querySelector("img");
  const label = preview?.querySelector("span");
  if (taskImagePreviewUrl) URL.revokeObjectURL(taskImagePreviewUrl);
  taskImagePreviewUrl = "";
  if (!file || !preview || !image) {
    if (preview) preview.hidden = true;
    return;
  }
  taskImagePreviewUrl = URL.createObjectURL(file);
  image.src = taskImagePreviewUrl;
  if (label) label.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  preview.hidden = false;
  if ($("taskExistingImageNote")) $("taskExistingImageNote").hidden = true;
  if ($("taskImageUrl")) $("taskImageUrl").value = "";
}

function openTaskEditor(id = "") {
  const activeRole = taskDashboardRole();
  const task = id ? state.tasks.find((item) => item.id === id) : null;
  if (id && !canManageTask(task)) return showToast("You can only edit tasks assigned to teams you manage or created in the Leaders account.", "error");
  if (!canCreateTaskForRole(activeRole)) {
    if (state.role === "leaders") showToast("An admin must assign your university or position team before you can assign tasks.", "error");
    return;
  }
  if (!$("taskForm") || $("taskForm").dataset.saving === "true") return;
  $("taskForm").reset();
  $("taskForm").dataset.taskId = task?.id || "";
  if (taskImagePreviewUrl) {
    URL.revokeObjectURL(taskImagePreviewUrl);
    taskImagePreviewUrl = "";
  }
  if ($("taskImageUrl")) $("taskImageUrl").value = task?.imageUrl || "";
  if ($("taskImageUploadProgress")) {
    $("taskImageUploadProgress").hidden = true;
    $("taskImageUploadProgress").value = 0;
  }
  if ($("taskImagePreview")) $("taskImagePreview").hidden = true;
  if ($("taskExistingImageNote")) {
    $("taskExistingImageNote").hidden = !task?.coverDriveFileId;
    $("taskExistingImageNote").textContent = task?.coverDriveFileId
      ? `Current Google Drive photo: ${task.coverDriveFileName || "uploaded image"}. It stays attached unless you choose a replacement.`
      : "";
  }
  $("taskTitle").value = task?.title || "";
  $("taskDescription").value = task?.description || "";
  $("taskXp").value = String(task?.xp ?? 50);
  if ($("taskDueAt")) {
    const due = attendanceDate(task?.dueAt);
    $("taskDueAt").value = due
      ? new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "";
  }
  const targetRole = $("taskTargetRole");
   const allowedRoles = state.role === "admin" || hasDashboardAccess("tasksManage")
     ? TASK_ROLE_ORDER
     : state.role === "leaders"
       ? ASSIGNABLE_DASHBOARD_ROLES
       : currentTeamLeadRoles();
  if (targetRole) {
    const options = allowedRoles.filter((roleKey) => canCreateTaskForRole(roleKey))
      .map((roleKey) => `<option value="${escapeAttr(roleKey)}">${escapeHtml(taskTargetRole({ targetRole: roleKey }))}</option>`).join("");
    targetRole.innerHTML = `<optgroup label="Account roles">${options}</optgroup>${state.role === "admin" ? `<optgroup label="Leadership positions"><option value="${POSITION_LEADER_TASK_AUDIENCE}">Position leaders — all teams</option></optgroup>` : ""}`;
    targetRole.value = task && canCreateTaskForRole(task.targetRole) ? task.targetRole
      : allowedRoles.includes(activeRole) && canCreateTaskForRole(activeRole) ? activeRole
        : (allowedRoles.find((roleKey) => canCreateTaskForRole(roleKey)) || "");
    if (task) targetRole.value = task.targetRole;
    targetRole.disabled = Boolean(task && (taskAssignmentLocked(task) || !hasDashboardAccess("tasksManage")));
  }
  const targetUniversity = $("taskTargetUniversity");
  const memberScope = taskUniversityScopeForCurrentUser();
  if (targetUniversity) {
    if (state.role === "admin") {
      targetUniversity.innerHTML = `<option value="">All universities</option>${UNIVERSITY_OPTIONS.map((university) => `<option value="${escapeAttr(university.tag)}">${escapeHtml(university.name)}</option>`).join("")}`;
      targetUniversity.disabled = false;
      targetUniversity.value = task?.targetUniversityTag || "";
    } else if (state.role === "leaders") {
      targetUniversity.innerHTML = memberScope
        ? `<option value="${escapeAttr(memberScope)}">${escapeHtml(universityLabel(memberScope))}</option>`
        : `<option value="">No university assigned</option>`;
      targetUniversity.value = memberScope;
      targetUniversity.disabled = true;
    } else {
      targetUniversity.innerHTML = `<option value="">All universities</option>`;
      targetUniversity.value = task?.targetUniversityTag || "";
      targetUniversity.disabled = true;
    }
    targetUniversity.disabled = Boolean(task && taskAssignmentLocked(task)) || targetUniversity.disabled;
  }
  if ($("taskMemberSearch")) $("taskMemberSearch").value = "";
  refreshTaskMemberSelector(task?.assignedMemberUids || []);
  const audienceLocked = Boolean(task && (taskAssignmentLocked(task) || !hasDashboardAccess("tasksManage")));
  $("taskAssignedMembers")?.querySelectorAll("input").forEach((input) => { input.disabled = audienceLocked; });
  if ($("taskMemberSearch")) $("taskMemberSearch").disabled = audienceLocked;
  $("taskMode").value = task?.mode || "all";
   $("taskMode").disabled = Boolean(task && (taskAssignmentLocked(task) || !hasDashboardAccess("tasksManage")));
  $("taskModalTitle").textContent = task ? "Edit task" : "Assign a task";
  const submitButton = $("taskForm").querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.textContent = task ? "Save changes" : "Assign task";
    submitButton.disabled = false;
  }
  const intro = $("taskModal")?.querySelector(".modal-intro");
  if (intro) intro.textContent = state.role === "admin"
    ? "Choose a team, optional university, and specific people. Leave people unselected to assign the task to the whole matching team."
    : state.role === "leaders" && universityByTag(memberScope)
       ? `Tasks you create are limited to ${universityLabel(memberScope)}. Choose a team and optionally specific people from that university.`
       : state.role === "leaders"
         ? `Your task access is limited to the position teams an admin assigned to you: ${currentTeamLeadRoles().map((role) => ROLE_CONFIG[role]?.label || role).join(", ") || "none yet"}.`
      : "Create tasks only for the team role you lead, and choose people from that team.";
  if (intro && task) intro.textContent = `Update the task details. Its audience is locked after the first submission or when the task closes. Existing submissions and awarded XP are preserved.`;
  const assetRows = $("taskAssetsEditor")?.querySelector(".link-editor-rows");
  if (assetRows) {
    assetRows.innerHTML = "";
    for (const asset of (task?.assets || []).slice(0, MAX_TASK_ASSETS)) {
      assetRows.insertAdjacentHTML("beforeend", linkEditorRowMarkup());
      const row = assetRows.lastElementChild;
      row.querySelector("[data-link-label]").value = asset.label || "";
      row.querySelector("[data-link-url]").value = asset.url || "";
    }
  }
  if ($("taskGameType")) $("taskGameType").value = task?.gameType || "none";
  if ($("taskGameUrl")) $("taskGameUrl").value = task?.gameUrl || "";
  if ($("taskGameHtml")) $("taskGameHtml").value = task?.gameHtml || "";
  toggleTaskGameFields();
  updateTaskGameHtmlSize();
  openModal("taskModal");
}

function buildTaskGameSrcdoc(html) {
  const bridge = `<script>window.NawrasTask={complete:function(r){r=r||{};parent.postMessage(Object.assign({},r,{type:"${TASK_GAME_MESSAGE_TYPE}"}),"*");}};<\/script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}${bridge}`);
  return `${bridge}${html}`;
}

function openTaskGame(id, forcePreview = false) {
  const task = state.tasks.find((item) => item.id === id);
  const frame = $("taskGameFrame");
  if (!task || !frame || !taskHasGame(task)) return;
  const preview = forcePreview || (state.role === "admin" && !canSubmitTaskAsCurrentUser(task));
  if (!preview && (task.status !== "open" || state.taskSubmissions[id])) return showToast("This task is no longer accepting submissions.", "error");
  Object.assign(taskGameState, { taskId: id, preview, submitting: false, finished: false, expectedOrigin: "" });
  $("taskGameModalTitle").textContent = task.title || "Interactive task";
  $("taskGameModalEyebrow").textContent = preview ? "Admin preview — results are not saved" : "Interactive task";
  setTaskGameSubmitButton({ disabled: false, label: "✓ تسليم التاسك" });
  setTaskGameStatus(preview ? "Preview mode. Submitting here does not create a submission." : "Finish the activity below, then press \"تسليم التاسك\" to send it to the admins for review.");
  frame.removeAttribute("src");
  frame.removeAttribute("srcdoc");
  if (task.gameType === "html") {
    frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-modals allow-forms");
    taskGameState.expectedOrigin = "null";
    frame.srcdoc = buildTaskGameSrcdoc(String(task.gameHtml));
  } else {
    const url = new URL(normalizeHttpUrl(task.gameUrl));
    const sandbox = ["allow-scripts", "allow-pointer-lock", "allow-modals", "allow-forms", "allow-popups"];
    if (url.origin !== window.location.origin) sandbox.push("allow-same-origin");
    frame.setAttribute("sandbox", sandbox.join(" "));
    taskGameState.expectedOrigin = url.origin;
    frame.src = url.toString();
  }
  openModal("taskGameModal");
}

function resetTaskGameFrame() {
  const frame = $("taskGameFrame");
  if (frame) {
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  }
  taskGameState.taskId = "";
}

function setTaskGameStatus(message, type = "") {
  const node = $("taskGameStatus");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-success", type === "success");
  node.classList.toggle("is-error", type === "error");
}

function sanitizeGameResult(data) {
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null);
  const result = { completedAtClient: new Date().toISOString() };
  const score = number(data.score);
  const maxScore = number(data.maxScore);
  if (score !== null) result.score = score;
  if (maxScore !== null) result.maxScore = maxScore;
  if (data.summary) result.summary = String(data.summary).slice(0, 500);
  if (data.details !== undefined) {
    let details;
    try {
      details = typeof data.details === "string" ? data.details : JSON.stringify(data.details, null, 2);
    } catch (_) {
      details = "";
    }
    if (details) result.details = details.slice(0, 2000);
  }
  return result;
}

async function handleTaskGameMessage(event) {
  const frame = $("taskGameFrame");
  if (!frame || !taskGameState.taskId || event.source !== frame.contentWindow) return;
  if (taskGameState.expectedOrigin && event.origin !== taskGameState.expectedOrigin) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.type !== TASK_GAME_MESSAGE_TYPE) return;
  if (taskGameState.finished || taskGameState.submitting) return;
  await submitTaskGameResult(sanitizeGameResult(data));
}

function setTaskGameSubmitButton({ disabled, label }) {
  const button = $("taskGameSubmitBtn");
  if (!button) return;
  button.disabled = disabled;
  if (label) button.innerHTML = label.startsWith("✓")
    ? `${materialIcon("task_alt")}${escapeHtml(label.slice(1).trim())}`
    : escapeHtml(label);
}

async function submitTaskGameResult(gameResult) {
  if (!taskGameState.taskId || taskGameState.finished || taskGameState.submitting) return;
  if (taskGameState.preview) {
    taskGameState.finished = true;
    setTaskGameSubmitButton({ disabled: true, label: "✓ تم (معاينة)" });
    const scoreText = gameResult.score !== undefined ? ` Score: ${gameResult.score}${gameResult.maxScore !== undefined ? ` / ${gameResult.maxScore}` : ""}.` : "";
    return setTaskGameStatus(`Preview: the task was marked as finished.${scoreText} Members' results will be sent for review.`, "success");
  }
  const draft = readTaskSubmissionDraft(taskGameState.taskId);
  if (draft.error) {
    setTaskGameStatus(`${draft.error} Fix the links on the task card, then submit again.`, "error");
    return showToast(draft.error, "error");
  }
  taskGameState.submitting = true;
  setTaskGameSubmitButton({ disabled: true, label: "جاري الإرسال…" });
  setTaskGameStatus("Finished! Sending your result for review…");
  const summary = gameResult.summary ? ` — ${gameResult.summary}` : "";
  const text = (draft.text || `Completed the interactive task${summary}`).slice(0, 3000);
  const ok = await createTaskSubmission(taskGameState.taskId, { text, links: draft.links, gameResult });
  taskGameState.submitting = false;
  if (ok) {
    taskGameState.finished = true;
    setTaskGameSubmitButton({ disabled: true, label: "✓ تم التسليم" });
    setTaskGameStatus("Your result was sent for review. XP is added after approval. You can close this window.", "success");
  } else {
    setTaskGameSubmitButton({ disabled: false, label: "✓ تسليم التاسك" });
    setTaskGameStatus("Your result could not be sent. Please try the Submit button again.", "error");
  }
}

async function saveTask(event) {
  event.preventDefault();
  const form = $("taskForm");
  const editId = form?.dataset.taskId || "";
  const existingTask = editId ? state.tasks.find((item) => item.id === editId) : null;
  if (form?.dataset.saving === "true") return;
  if (editId && !canManageTask(existingTask)) return showToast("You can only edit tasks assigned to teams you manage or created in the Leaders account.", "error");
  const title = $("taskTitle")?.value.trim();
  const description = $("taskDescription")?.value.trim();
  const targetRole = $("taskTargetRole")?.value;
  const targetUniversityTag = $("taskTargetUniversity")?.value || "";
  const assignedMemberUids = [...new Set([...taskSelectedMemberUids].filter(Boolean))];
  if (assignedMemberUids.length > 100) return showToast("Choose no more than 100 people for one task.", "error");
  const mode = $("taskMode")?.value;
  const xp = Number($("taskXp")?.value);
  const dueValue = $("taskDueAt")?.value || "";
  const dueAt = dueValue ? new Date(dueValue) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) return showToast("Choose a valid deadline.", "error");
  if (!title || title.length < 3) return showToast("Give the task a clear title.", "error");
  if (!description || description.length < 8) return showToast("Add enough instructions for the team.", "error");
  if (![...TASK_ROLE_ORDER, POSITION_LEADER_TASK_AUDIENCE].includes(targetRole)
    || (editId
      ? !existingTask || (!hasDashboardAccess("tasksManage") && targetRole !== existingTask.targetRole)
      : !canCreateTaskForRole(targetRole))) return showToast("You can only assign tasks to an audience you are permitted to manage.", "error");
  if (targetUniversityTag && !universityByTag(targetUniversityTag)) return showToast("Choose a valid university.", "error");
  if (state.role === "leaders" && targetUniversityTag !== taskLeaderUniversityTag()) {
    return showToast("You can only assign tasks to members of the university assigned to you.", "error");
  }
  const eligibleMembers = new Set(taskMemberChoices(targetRole, targetUniversityTag).map((member) => member.uid));
  if (assignedMemberUids.some((uid) => !eligibleMembers.has(uid))) {
    return showToast("Choose people who belong to the selected team and university.", "error");
  }
  if (!Object.keys(TASK_MODE_LABELS).includes(mode)) return showToast("Choose a valid submission mode.", "error");
  if (!Number.isInteger(xp) || xp < 1 || xp > 100000) return showToast("XP must be a whole number from 1 to 100,000.", "error");
  const assetResult = collectLinkEntries($("taskAssetsEditor"));
  if (assetResult.error) return showToast(assetResult.error, "error");
  const assets = assetResult.links.slice(0, MAX_TASK_ASSETS);
  const imageUrlInput = $("taskImageUrl")?.value.trim() || "";
  const imageUrl = normalizePhotoUrl(imageUrlInput);
  const coverFile = $("taskImageFile")?.files?.[0] || null;
  if (imageUrlInput && !imageUrl) return showToast("Use a valid http:// or https:// image link.", "error");
  if (coverFile && !isDriveStorageConfigured()) {
    return showToast("Google Drive photo uploads are not connected yet. Finish the Drive setup before uploading a task photo.", "error");
  }
  if (coverFile && !["image/jpeg", "image/png", "image/webp"].includes(coverFile.type)) {
    return showToast("Task photos must be JPG, PNG, or WebP images.", "error");
  }
  if (coverFile && coverFile.size > 10 * 1024 * 1024) {
    return showToast("Task photos must be 10 MB or smaller.", "error");
  }
  const gameType = $("taskGameType")?.value || "none";
  let gameUrl = "";
  let gameHtml = "";
  if (gameType === "url") {
    gameUrl = normalizeHttpUrl($("taskGameUrl")?.value);
    if (!gameUrl) return showToast("Enter a valid http or https URL for the interactive page.", "error");
  } else if (gameType === "html") {
    gameHtml = $("taskGameHtml")?.value.trim() || "";
    if (gameHtml.length < 20) return showToast("Paste the HTML code or upload an .html file.", "error");
    if (gameHtml.length > MAX_TASK_GAME_HTML) return showToast("The HTML must be under 500 KB.", "error");
  }
  const submitButton = form?.querySelector('button[type="submit"]');
  if (form) form.dataset.saving = "true";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";
  }
  let photoUploadError = null;
  try {
    const keepExistingDriveCover = Boolean(existingTask?.coverDriveFileId && !imageUrl);
    const keepExistingImageDuringUpload = Boolean(coverFile && existingTask?.imageUrl);
    const editable = {
      title, description, targetRole, targetUniversityTag, assignedMemberUids,
      audienceMode: assignedMemberUids.length ? "selected" : "all",
      mode, xp, assets, dueAt,
      imageUrl: coverFile ? (keepExistingImageDuringUpload ? existingTask.imageUrl : "") : imageUrl,
      coverDriveFileId: keepExistingDriveCover ? existingTask.coverDriveFileId : "",
      coverDriveFileName: keepExistingDriveCover ? existingTask.coverDriveFileName : "",
      coverDriveMimeType: keepExistingDriveCover ? existingTask.coverDriveMimeType : "",
      coverDriveSizeBytes: keepExistingDriveCover ? Number(existingTask.coverDriveSizeBytes) || 0 : 0,
      coverDriveUploadedByUid: keepExistingDriveCover ? existingTask.coverDriveUploadedByUid : "",
      coverDriveUploadedAt: keepExistingDriveCover ? existingTask.coverDriveUploadedAt : "",
      gameType: gameType === "none" ? "" : gameType, gameUrl, gameHtml,
      updatedAt: serverTimestamp()
    };
    let taskRef;
    if (editId) {
      taskRef = doc(db, "tasks", editId);
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(taskRef);
        if (!snapshot.exists()) throw new Error("This task was deleted. Close the editor and refresh the task list.");
        const current = snapshot.data();
        if (taskAssignmentLocked(current) && (current.targetRole !== targetRole || current.mode !== mode)) {
          throw new Error("This task now has submissions or is closed. Reopen the editor; its audience and submission mode cannot be changed.");
        }
        transaction.update(taskRef, editable);
      });
    } else {
      taskRef = await addDoc(collection(db, "tasks"), {
        ...editable, status: "open", submissionCount: 0, claimedByUid: "",
        createdBy: state.user.uid,
        createdByName: memberDisplayName(state.member, state.user),
        createdByPhotoURL: profilePhotoDisplayUrl(state.member),
        createdAt: serverTimestamp()
      });
    }
    if (coverFile) {
      try {
        const progress = $("taskImageUploadProgress");
        if (progress) { progress.hidden = false; progress.value = 0; }
        const uploaded = await uploadDriveFile(auth, coverFile, {
          category: "taskCover",
          sourceId: taskRef.id,
          targetRole,
          sizeBytes: coverFile.size
        }, {
          onProgress: (percent) => { if (progress) progress.value = percent; }
        });
        await updateDoc(taskRef, {
          imageUrl: "",
          coverDriveFileId: uploaded.id,
          coverDriveFileName: uploaded.fileName || coverFile.name,
          coverDriveMimeType: uploaded.mimeType || coverFile.type,
          coverDriveSizeBytes: Number(uploaded.sizeBytes) || coverFile.size,
          coverDriveUploadedByUid: state.user.uid,
          coverDriveUploadedAt: uploaded.uploadedAt || new Date().toISOString(),
          updatedAt: serverTimestamp()
        });
      } catch (error) { photoUploadError = error; }
    }
    let assignmentError = null;
    try {
      await syncTaskRecipientAssignments(taskRef.id, existingTask?.assignedMemberUids || [], assignedMemberUids);
    } catch (error) { assignmentError = error; }
    let notificationError = null;
    try {
      const recipientSnapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
      const recipients = recipientSnapshot.docs.map((item) => ({ uid: item.id, ...item.data() })).filter((member) =>
        taskMatchesAudience({ targetRole, targetUniversityTag, assignedMemberUids }, member, member.uid));
      await notifyInboxMembers(
        recipients,
        "task_available",
        `${editId ? "Task updated" : "New task"} for ${taskTargetRole({ targetRole })}: ${title}`,
        `${editId ? "A task manager updated this task. Open it to review the latest details." : "A new task is ready for your team."} Reward: up to ${xp} XP.`,
        { taskId: taskRef.id, taskRole: targetRole }
      );
    } catch (error) { notificationError = error; }
    closeModal("taskModal");
    if (editId) refs.taskSubmissionsViewer?.classList.add("hidden");
    showToast(assignmentError
      ? `Task saved, but individual assignments could not be updated: ${firebaseError(assignmentError)}`
      : notificationError
        ? `Task ${editId ? "saved" : "assigned"}, but inbox notices could not be sent: ${firebaseError(notificationError)}`
        : photoUploadError
          ? `Task saved, but its photo could not be uploaded: ${firebaseError(photoUploadError)}. You can edit the task and try again.`
          : editId ? "Task updated. Existing submissions and awarded XP were preserved."
            : `Task assigned to ${taskTargetLabel({ targetRole })} and they were notified.`,
      assignmentError || notificationError || photoUploadError ? "error" : "ok");
    await loadTasks();
  } catch (error) {
    showToast(firebaseError(error), "error");
  } finally {
    if (form) form.dataset.saving = "false";
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = editId ? "Save changes" : "Assign task";
    }
  }
}

async function syncTaskRecipientAssignments(taskId, previousUids, nextUids) {
  const previous = new Set(Array.isArray(previousUids) ? previousUids : []);
  const next = new Set(Array.isArray(nextUids) ? nextUids : []);
  if ([...previous].every((uid) => next.has(uid)) && [...next].every((uid) => previous.has(uid))) return;
  const operations = [];
  for (const uid of previous) {
    if (!next.has(uid)) operations.push((batch) => batch.delete(doc(db, "teamMembers", uid, "taskAssignments", taskId)));
  }
  for (const uid of next) {
    if (!previous.has(uid)) {
      operations.push((batch) => batch.set(doc(db, "teamMembers", uid, "taskAssignments", taskId), {
        taskId, createdAt: serverTimestamp()
      }));
    }
  }
  for (let offset = 0; offset < operations.length; offset += 10) {
    const batch = writeBatch(db);
    operations.slice(offset, offset + 10).forEach((apply) => apply(batch));
    await batch.commit();
  }
}

function readTaskSubmissionDraft(id) {
  const text = $(`task-text-${id}`)?.value.trim() || "";
  const editor = findLinkEditor($("taskDetailsContent"), id) || findLinkEditor(refs.tasksList, id);
  const linkResult = collectLinkEntries(editor);
  return { text, links: linkResult.links, error: linkResult.error };
}

async function submitTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (!canSubmitTaskAsCurrentUser(task)) return showToast("This task is not assigned to your account or team.", "error");
  const draft = readTaskSubmissionDraft(id);
  if (draft.error) return showToast(draft.error, "error");
  if (taskHasGame(task)) {
    if (!draft.links.length && draft.text.length < 3) return showToast("Write a short note or add a link before submitting.", "error");
    const text = draft.text.length >= 3 ? draft.text : "Submitted the interactive task with a link.";
    return createTaskSubmission(id, { text, links: draft.links });
  }
  if (draft.text.length < 3) return showToast("Write a short description of what you completed.", "error");
  return createTaskSubmission(id, { text: draft.text, links: draft.links });
}

async function createTaskSubmission(id, { text, links = [], gameResult = null }) {
  if (!canSubmitTaskAsCurrentUser(state.tasks.find((item) => item.id === id))) {
    showToast("This task is not assigned to your account or team.", "error");
    return false;
  }
  const link = links[0]?.url || "";
  const taskRef = doc(db, "tasks", id);
  const submissionRef = doc(db, "tasks", id, "submissions", state.user.uid);
  const currentName = memberDisplayName(state.member, state.user);
  try {
    await runTransaction(db, async (transaction) => {
      const [taskSnapshot, submissionSnapshot] = await Promise.all([
        transaction.get(taskRef),
        transaction.get(submissionRef)
      ]);
      if (!taskSnapshot.exists()) throw new Error("This task no longer exists.");
      const taskData = taskSnapshot.data();
      if (!canSubmitTaskAsCurrentUser(taskData)) throw new Error("This task is assigned to another team or account.");
      if (taskData.status !== "open") throw new Error("This task is no longer accepting submissions.");
      if (submissionSnapshot.exists()) throw new Error("You have already submitted this task.");
      const submissionData = {
        taskId: id, submitterUid: state.user.uid, submitterName: currentName,
        teamRole: taskData.targetRole, text, link, links, xpAwarded: 0, status: "pending",
        submittedAt: serverTimestamp()
      };
      if (gameResult) submissionData.gameResult = gameResult;
      transaction.set(submissionRef, submissionData);
      transaction.update(taskRef, {
        submissionCount: Math.max(0, Number(taskData.submissionCount) || 0) + 1,
        updatedAt: serverTimestamp()
      });
    });
    let notificationError = null;
    try {
    const task = state.tasks.find((item) => item.id === id);
    const reviewers = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
    const reviewerMembers = reviewers.docs.map((item) => ({ uid: item.id, ...item.data() }))
      .filter((member) => member.role === "admin"
        || (member.role === "leaders" && task?.createdBy === member.uid)
        || (task?.targetRole !== POSITION_LEADER_TASK_AUDIENCE
          && Array.isArray(member.teamLeadRoles) && member.teamLeadRoles.includes(task?.targetRole)));
      await notifyInboxMembers(reviewerMembers,
        "task_submitted", "A task is ready for review",
        `${currentName} submitted ${task?.title || "a task"} for review.`,
        { taskId: id, taskRole: task?.targetRole || "" }, 3, `task-submitted_${id}_${state.user.uid}`);
    } catch (error) { notificationError = error; }
    updateProfileSummary();
    showToast(notificationError
      ? "Task submitted successfully, but the reviewer inbox notice could not be sent. Do not submit again."
      : "Task submitted for review. XP will be added after approval.",
      notificationError ? "error" : "ok");
    await loadTasks();
    return true;
  } catch (error) {
    showToast(firebaseError(error), "error");
    return false;
  }
}

async function viewTaskSubmissions(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || !canManageTask(task) || !refs.taskSubmissionsViewer) return;
  refs.taskSubmissionsViewer.classList.remove("hidden");
  refs.taskSubmissionsViewer.innerHTML = `<div class="empty-state">Loading submissions…</div>`;
  try {
    let snapshot;
    try {
      snapshot = await getDocs(query(collection(db, "tasks", id, "submissions"), orderBy("submittedAt", "desc")));
    } catch (_) {
      snapshot = await getDocs(collection(db, "tasks", id, "submissions"));
    }
    const submissions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    refs.taskSubmissionsViewer.innerHTML = `<div class="task-submissions-heading"><div><span class="panel-kicker">Task submissions</span><h3>${escapeHtml(task.title)}</h3><p class="panel-hint">Choose an XP amount for each approved submission. A first-submission task closes when one submission is approved.</p></div><button type="button" class="btn btn-outline btn-compact" id="closeTaskSubmissionsBtn">Close</button></div>${submissions.length ? `<div class="task-submission-list">${submissions.map((submission) => {
      const reviewStatus = submission.status || (Number(submission.xpAwarded) > 0 ? "approved" : "pending");
      const reviewed = reviewStatus !== "pending";
      return `<article class="task-submission ${reviewStatus === "approved" ? "is-approved" : reviewStatus === "rejected" ? "is-rejected" : "is-pending"}"><div class="task-submission-top"><strong>${escapeHtml(submission.submitterName || "Team member")}</strong><span>${escapeHtml(formatDate(submission.submittedAt))} · ${reviewStatus === "pending" ? "Awaiting review" : `${reviewStatus === "approved" ? "+" : ""}${Number(submission.xpAwarded) || 0} XP · ${escapeHtml(reviewStatus)}`}</span></div><p>${escapeHtml(submission.text)}</p>${taskGameResultMarkup(submission)}${taskSubmissionLinksMarkup(submission)}${reviewed ? `<div class="review-result">${reviewStatus === "approved" ? "Approved and rewarded." : "Rejected — no XP awarded."}</div>` : `<form class="submission-review-form" data-review-submission="${escapeAttr(submission.id)}"><label>XP to award<input type="number" name="xp" min="0" max="100000" step="1" value="${Number(task.xp) || 0}" required></label><button class="btn btn-primary btn-compact" type="submit" data-review-decision="approved">Approve & award XP</button><button class="btn btn-outline btn-compact" type="submit" data-review-decision="rejected">Reject</button></form>`}</article>`;
    }).join("")}</div>` : `<div class="empty-state">No submissions yet.</div>`}`;
    if (!canManageTask(task)) refs.taskSubmissionsViewer.querySelectorAll(".submission-review-form").forEach((form) => form.remove());
    $("closeTaskSubmissionsBtn")?.addEventListener("click", () => refs.taskSubmissionsViewer.classList.add("hidden"));
    refs.taskSubmissionsViewer.querySelectorAll("[data-review-submission]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      reviewTaskSubmission(id, form.dataset.reviewSubmission, event.submitter?.dataset.reviewDecision || "approved", form.querySelector("[name=xp]")?.value);
    }));
  } catch (error) {
    refs.taskSubmissionsViewer.innerHTML = `<div class="empty-state">Submissions could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

async function reviewTaskSubmission(taskId, submissionUid, decision, rawXp) {
  if (state.role !== "admin" && submissionUid === state.user?.uid) return showToast("Ask another task manager to review your own submission.", "error");
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !canManageTask(task)) return showToast("You can only review submissions for teams you manage or tasks you created.", "error");
  const xp = decision === "approved" ? Number(rawXp) : 0;
  if (decision === "approved" && (!Number.isInteger(xp) || xp < 0 || xp > 100000)) return showToast("XP must be a whole number from 0 to 100,000.", "error");
  const taskRef = doc(db, "tasks", taskId);
  const submissionRef = doc(db, "tasks", taskId, "submissions", submissionUid);
  const memberRef = doc(db, "teamMembers", submissionUid);
  const inboxRef = doc(collection(db, "teamMembers", submissionUid, "notifications"));
  try {
    await runTransaction(db, async (transaction) => {
      const [taskSnapshot, submissionSnapshot, memberSnapshot] = await Promise.all([
        transaction.get(taskRef), transaction.get(submissionRef), transaction.get(memberRef)
      ]);
      if (!taskSnapshot.exists() || !submissionSnapshot.exists()) throw new Error("This submission no longer exists.");
      const taskData = taskSnapshot.data();
      if (!canManageTask(taskData)) throw new Error("You can only review submissions for teams you manage or tasks you created.");
      const submissionData = submissionSnapshot.data();
      const currentStatus = submissionData.status || (Number(submissionData.xpAwarded) > 0 ? "approved" : "pending");
      if (currentStatus !== "pending") throw new Error("This submission has already been reviewed.");
      if (decision === "approved" && taskData.mode === "first" && taskData.status !== "open") throw new Error("Another submission was already approved for this first-submission task.");
      if (!memberSnapshot.exists()) throw new Error("The submitting member profile could not be found.");
      const memberData = memberSnapshot.data();
      const currentXp = Math.max(0, Number(memberData.xp) || 0);
      const nextXp = currentXp + xp;
      const currentTasks = Math.max(0, Number(memberData.tasksCompleted) || 0);
      transaction.update(submissionRef, {
        status: decision === "approved" ? "approved" : "rejected",
        xpAwarded: xp, reviewedByUid: state.user.uid, reviewedAt: serverTimestamp()
      });
      transaction.set(inboxRef, inboxNotificationData(
        "task_review",
        decision === "approved" ? "Task submission approved" : "Task submission needs changes",
        decision === "approved"
          ? `Your submission for “${taskData.title}” was approved. ${xp} XP was added.`
          : `Your submission for “${taskData.title}” was reviewed and needs changes. No XP was added.`,
         { taskId, taskRole: taskData.targetRole, reviewStatus: decision }
      ));
      if (decision === "approved") {
        transaction.update(memberRef, {
          xp: nextXp, level: levelForXp(nextXp), tasksCompleted: currentTasks + 1,
          lastTaskId: taskId, updatedAt: serverTimestamp()
        });
      }
      if (taskData.mode === "first" && decision === "approved") {
        transaction.update(taskRef, { status: "closed", claimedByUid: submissionUid, updatedAt: serverTimestamp() });
      }
    });
    showToast(decision === "approved" ? `Submission approved. +${xp} XP awarded.` : "Submission rejected. No XP awarded.");
    await loadTasks();
    await loadTeamMembers();
    await viewTaskSubmissions(taskId);
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function closeTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || !canManageTask(task)) return showToast("You can only manage tasks for teams you lead or tasks you created.", "error");
  if (task.status !== "open" || !confirm(`Close “${task.title}”? Team members will no longer be able to submit it.`)) return;
  try {
    await updateDoc(doc(db, "tasks", id), { status: "closed", updatedAt: serverTimestamp() });
    showToast("Task closed.");
    await loadTasks();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function deleteTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task || !canManageTask(task)) return showToast("You can only manage tasks for teams you lead or tasks you created.", "error");
  if (!confirm(`Delete “${task.title}”? Its submission records will remain unless removed separately.`)) return;
  try {
    await syncTaskRecipientAssignments(id, task.assignedMemberUids || [], []);
    await deleteDoc(doc(db, "tasks", id));
    showToast("Task deleted.");
    if (refs.taskSubmissionsViewer) refs.taskSubmissionsViewer.classList.add("hidden");
    await loadTasks();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function loadPublicQuestions() {
  if (!refs.publicQuestionsList) return;
  try {
    let snapshot;
    try {
      snapshot = await getDocs(query(collection(db, "questions"), where("status", "==", "answered"), orderBy("answeredAt", "desc")));
    } catch (_) {
      snapshot = await getDocs(query(collection(db, "questions"), where("status", "==", "answered")));
    }
    const questions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => sortTimestampDesc(a.answeredAt, b.answeredAt));
    refs.publicQuestionsList.innerHTML = questions.length ? questions.map(publicQuestionCard).join("") : `<div class="empty-state">No answered questions yet. Be the first to ask.</div>`;
    if (refs.publicQuestionCount) refs.publicQuestionCount.textContent = String(questions.length);
  } catch (error) {
    refs.publicQuestionsList.innerHTML = `<div class="empty-state">Answered questions could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

async function loadTeamQuestions() {
  if (!state.isTeam || !refs.teamQuestionsList) return;
  try {
    let snapshot;
    const base = collection(db, "questions");
    const inboxRole = hasDashboardAccess("questionsRead") ? "admin" : state.role === "admin" && state.activeDashboardRole !== "admin"
      ? state.activeDashboardRole
      : state.role;
    try {
      snapshot = inboxRole === "admin"
        ? await getDocs(query(base, where("status", "==", "open"), orderBy("createdAt", "desc")))
        : await getDocs(query(base, where("targetRole", "==", inboxRole), where("status", "==", "open"), orderBy("createdAt", "desc")));
    } catch (_) {
      snapshot = inboxRole === "admin"
        ? await getDocs(query(base, where("status", "==", "open")))
        : await getDocs(query(base, where("targetRole", "==", inboxRole), where("status", "==", "open")));
    }
    state.questions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => sortTimestampDesc(a.createdAt, b.createdAt));
    renderTeamQuestions(state.questions);
  } catch (error) {
    refs.teamQuestionsList.innerHTML = `<div class="empty-state">Questions could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function renderTeamQuestions(items) {
  if (!refs.teamQuestionsList) return;
  refs.teamQuestionsList.innerHTML = items.length ? items.map((item) => `
    <article class="question-card team-question-card">
      <div class="question-card-top"><span class="card-tag">${escapeHtml(ROLE_CONFIG[item.targetRole]?.label || item.targetRole)} question</span><span class="question-date">${escapeHtml(formatDate(item.createdAt))}</span></div>
      <h3>${escapeHtml(item.question)}</h3>
      <label class="answer-field">Your public answer<textarea id="answer-${escapeAttr(item.id)}" rows="4" maxlength="1500" placeholder="Write an answer that will help the whole community..."></textarea></label>
      ${linkEditorMarkup("answer", item.id, "Add answer button", "Add up to 3 buttons that link to helpful resources.")}
      <button type="button" class="btn btn-primary btn-compact" data-answer-question="${escapeAttr(item.id)}">Publish answer</button>
    </article>`).join("") : `<div class="empty-state">No unanswered questions for this dashboard.</div>`;
  refs.teamQuestionsList.querySelectorAll("[data-answer-question]").forEach((button) => button.addEventListener("click", () => answerQuestion(button.dataset.answerQuestion)));
  refs.teamQuestionsList.querySelectorAll("[data-answer-question]").forEach((button) => {
    const question = items.find((item) => item.id === button.dataset.answerQuestion);
    if (hasDashboardAccess("questionsManage")) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-danger btn-compact";
      remove.textContent = "Delete question";
      remove.addEventListener("click", async () => {
        if (!confirm("Delete this question permanently?")) return;
        try { await deleteDoc(doc(db, "questions", question.id)); await loadTeamQuestions(); }
        catch (error) { showToast(firebaseError(error), "error"); }
      });
      button.closest("article").appendChild(remove);
    } else if (question?.targetRole !== state.role) {
      button.closest("article").querySelectorAll(".answer-field,.link-editor,[data-answer-question]").forEach((element) => element.remove());
    }
  });
  bindLinkEditors(refs.teamQuestionsList);
}

async function answerQuestion(id) {
  const answerInput = $(`answer-${id}`);
  const answer = answerInput?.value.trim();
  if (!answer || answer.length < 8) return showToast("Please write a complete answer before publishing.", "error");
  const editor = findLinkEditor(refs.teamQuestionsList, id);
  const linkResult = collectLinkEntries(editor);
  if (linkResult.error) return showToast(linkResult.error, "error");
  const links = linkResult.links;
  const question = state.questions.find((item) => item.id === id);
  if (!question) return;
  if (question.targetRole !== state.role && !hasDashboardAccess("questionsManage")) return showToast("Question management access is required.", "error");
  const answeredByRole = question.targetRole || state.role;
  const memberRef = doc(db, "teamMembers", state.user.uid);
  const questionRef = doc(db, "questions", id);
  const askerInboxRef = question.ownerUid ? doc(collection(db, "teamMembers", question.ownerUid, "notifications")) : null;
  const currentName = memberDisplayName(state.member, state.user);
  const currentPhoto = normalizePhotoUrl(state.member?.photoURL || "");
  try {
    await runTransaction(db, async (transaction) => {
      const [questionSnapshot, memberSnapshot] = await Promise.all([
        transaction.get(questionRef),
        transaction.get(memberRef)
      ]);
      if (!questionSnapshot.exists() || questionSnapshot.data().status !== "open") {
        throw new Error("This question was already answered by another team member.");
      }
      const memberData = memberSnapshot.exists() ? memberSnapshot.data() : {};
      const xp = Math.max(0, Number(memberData.xp) || 0) + XP_PER_ANSWER;
      const level = levelForXp(xp);
      const answersCount = Math.max(0, Number(memberData.answersCount) || 0) + 1;
      transaction.update(questionRef, {
        status: "answered", answered: true, answer, links, answeredAt: serverTimestamp(),
        answeredByUid: state.user.uid, answeredByName: currentName,
        answeredByPhotoURL: currentPhoto, answeredByRole, answeredByLevel: level
      });
      if (askerInboxRef && questionSnapshot.data().ownerUid === question.ownerUid) {
        transaction.set(askerInboxRef, inboxNotificationData(
          "question_answer",
          "Your question has been answered",
          `Question: ${question.question.slice(0, 260)}\nAnswer: ${answer.slice(0, 1050)}`,
          { questionId: id }
        ));
      }
      transaction.set(memberRef, {
        displayName: currentName, photoURL: currentPhoto,
        xp, level, answersCount, lastAnsweredQuestionId: id, updatedAt: serverTimestamp()
      }, { merge: true });
      state.member = { ...state.member, ...memberData, displayName: currentName, photoURL: currentPhoto, xp, level, answersCount };
    });
    updateProfileSummary();
    showToast(`Answer published. +${XP_PER_ANSWER} XP — you are now level ${state.member.level}.`);
    await loadTeamQuestions();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

function publicQuestionCard(item) {
  const authorName = item.answeredByName || ROLE_CONFIG[item.answeredByRole]?.label || ROLE_CONFIG[item.targetRole]?.label || "NAWRAS team";
  const author = profileIdentityMarkup({
    uid: item.answeredByUid,
    displayName: authorName,
    photoURL: item.answeredByPhotoURL,
    level: item.answeredByLevel
  });
  return `<article class="question-card public-question-card"><div class="question-card-top"><span class="card-tag">${escapeHtml(ROLE_CONFIG[item.targetRole]?.label || item.targetRole)} question</span><span class="question-date">${escapeHtml(formatDate(item.answeredAt))}</span></div><h3>${escapeHtml(item.question)}</h3><div class="question-answer"><div class="answer-author">${author}</div><p>${escapeHtml(item.answer)}</p>${renderLinkButtons(item.links)}</div></article>`;
}

function sortTimestampDesc(a, b) {
  const value = (timestamp) => timestamp?.seconds || (timestamp ? new Date(timestamp).getTime() / 1000 : 0);
  return value(b) - value(a);
}

function levelForXp(xp) {
  return Math.max(1, Math.floor(Math.max(0, Number(xp) || 0) / XP_PER_LEVEL) + 1);
}

function memberDisplayName(member, user) {
  return String(member?.displayName || user?.displayName || user?.email?.split("@")[0] || "NAWRAS team member").trim();
}

function normalizePhotoUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

function profilePhotoDisplayUrl(profile) {
  return driveProfilePhotoUrl(profile?.photoDriveFileId) || normalizePhotoUrl(profile?.photoURL || "");
}

function normalizeHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value).trim());
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

const PRIMARY_SITE_ORIGIN = "https://nawrasedu.site.je";
const SECONDARY_SITE_HOSTS = new Set(["nawrasedu.site", "www.nawrasedu.site"]);

// Older NawrasOnline links may point at nawrasedu.site; always send members to the primary domain.
function primaryDomainSessionUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  if (!SECONDARY_SITE_HOSTS.has(url.hostname.toLowerCase()) || !url.pathname.includes("nawras-online")) return normalized;
  return new URL(`${url.pathname}${url.search}${url.hash}`, PRIMARY_SITE_ORIGIN).toString();
}

function linkEditorMarkup(kind, ownerId, addButtonText, helpText) {
  return `<div class="link-editor" data-link-editor-owner="${escapeAttr(ownerId)}" data-link-editor-kind="${escapeAttr(kind)}"><p class="link-editor-help">${escapeHtml(helpText)}</p><div class="link-editor-rows"></div><button type="button" class="btn btn-outline btn-compact link-editor-add" data-link-editor-add>${materialIcon("add")} ${escapeHtml(addButtonText)}</button></div>`;
}

function findLinkEditor(root, ownerId) {
  return [...(root?.querySelectorAll("[data-link-editor-owner]") || [])]
    .find((editor) => editor.dataset.linkEditorOwner === ownerId);
}

function linkEditorRowMarkup() {
  return `<div class="link-editor-row"><label>Button label<input type="text" data-link-label maxlength="60" placeholder="e.g. Read more"></label><label>URL<input type="url" data-link-url maxlength="1000" placeholder="https://example.com"></label><button type="button" class="btn btn-outline btn-compact link-editor-remove" data-link-editor-remove aria-label="Remove link">Remove</button></div>`;
}

function bindLinkEditors(root) {
  root?.querySelectorAll("[data-link-editor-owner]").forEach((editor) => {
    if (editor.dataset.linkEditorBound === "true") return;
    editor.dataset.linkEditorBound = "true";
    editor.addEventListener("click", (event) => {
      const addButton = event.target.closest("[data-link-editor-add]");
      if (addButton) {
        const rows = editor.querySelector(".link-editor-rows");
        const maxRows = Number(editor.dataset.linkEditorMax) || 3;
        if (rows.querySelectorAll(".link-editor-row").length >= maxRows) {
          showToast(`You can add up to ${maxRows} links.`, "error");
          return;
        }
        rows.insertAdjacentHTML("beforeend", linkEditorRowMarkup());
        return;
      }
      const removeButton = event.target.closest("[data-link-editor-remove]");
      if (removeButton) removeButton.closest(".link-editor-row")?.remove();
    });
  });
}

function collectLinkEntries(editor) {
  const links = [];
  for (const row of editor?.querySelectorAll(".link-editor-row") || []) {
    const label = row.querySelector("[data-link-label]")?.value.trim() || "";
    const rawUrl = row.querySelector("[data-link-url]")?.value.trim() || "";
    if (!label && !rawUrl) continue;
    if (!label || !rawUrl) return { links: [], error: "Fill in both the button label and URL for each link." };
    const url = normalizeHttpUrl(rawUrl);
    if (!url) return { links: [], error: "Use a valid http or https URL for each link." };
    links.push({ label, url });
  }
  return { links, error: "" };
}

function renderLinkButtons(links) {
  if (!Array.isArray(links)) return "";
  const safeLinks = links.slice(0, 3).map((link, index) => {
    const url = normalizeHttpUrl(link?.url);
    if (!url) return "";
    const label = String(link?.label || `Open link ${index + 1}`).trim();
    return `<a class="btn btn-outline btn-compact answer-link-button" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ${materialIcon("open_in_new")}</a>`;
  }).filter(Boolean);
  return safeLinks.length ? `<div class="answer-link-buttons">${safeLinks.join("")}</div>` : "";
}

function taskSubmissionLinksMarkup(submission) {
  const links = Array.isArray(submission.links) ? submission.links : [];
  if (links.length) return renderLinkButtons(links);
  const legacyUrl = normalizeHttpUrl(submission.link);
  return legacyUrl ? renderLinkButtons([{ label: "Open submitted link", url: legacyUrl }]) : "";
}

function profileAvatarMarkup(profile, size = "small") {
  const name = memberDisplayName(profile);
  const photo = profilePhotoDisplayUrl(profile);
  const fallback = normalizePhotoUrl(profile?.photoURL || "");
  return photo
    ? `<img class="profile-avatar profile-avatar-${size}" src="${escapeAttr(photo)}"${fallback && fallback !== photo ? ` data-fallback-src="${escapeAttr(fallback)}"` : ""} alt="${escapeAttr(name)}" loading="${size === "hero" ? "eager" : "lazy"}" decoding="async"${size === "hero" ? ' fetchpriority="high"' : ""} referrerpolicy="no-referrer">`
    : `<span class="profile-avatar profile-avatar-${size} profile-avatar-fallback" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
}

document.addEventListener("error", (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches("img.profile-avatar[data-fallback-src]")) return;
  const fallback = image.dataset.fallbackSrc;
  image.removeAttribute("data-fallback-src");
  if (fallback) image.src = fallback;
}, true);

function profileIdentityMarkup(profile) {
  const name = memberDisplayName(profile);
  const role = ROLE_CONFIG[profile?.role]?.label || "";
  const level = levelForXp(profile?.xp ?? ((Number(profile?.level) || 1) - 1) * XP_PER_LEVEL);
  const identity = `<span class="profile-identity">${profileAvatarMarkup(profile)}<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role || `Level ${level}`)} · Level ${level}</small></span></span>`;
  return profile?.uid ? `<a class="profile-link" href="profile.html?uid=${encodeURIComponent(profile.uid)}">${identity}</a>` : identity;
}

function addProfilePhotoControls() {
  const form = $("profileForm");
  const saveButton = form?.querySelector('button[type="submit"]');
  if (!form || !saveButton || $("profilePhotoFile")) return;
  saveButton.id = "saveProfileBtn";
  saveButton.insertAdjacentHTML("beforebegin", `
    <div class="profile-photo-tools">
      <label>Upload a profile photo
        <input id="profilePhotoFile" type="file" accept="image/jpeg,image/png,image/webp">
        <small>Choose a JPEG, PNG, or WebP image up to 10 MB. It is resized first, then uploaded privately through the secured Drive service. Profile photos are made individually viewable so they can appear across the website.</small>
      </label>
      <div class="profile-photo-preview-row">
        <img id="profilePhotoPreviewImage" class="profile-photo-preview-image" alt="Profile photo preview" hidden>
        <span id="profilePhotoPreviewFallback" class="profile-photo-preview-fallback">No photo selected</span>
        <span class="profile-photo-preview-label">Preview</span>
      </div>
      <progress id="profilePhotoProgress" class="drive-upload-progress" max="100" value="0" hidden></progress>
      <small id="profilePhotoStatus" class="profile-photo-status" aria-live="polite"></small>
    </div>
  `);

  $("profilePhotoFile")?.addEventListener("change", handleProfilePhotoSelection);
  $("profilePhotoUrl")?.addEventListener("input", () => {
    state.profilePhotoFile = null;
    if ($("profilePhotoFile")) $("profilePhotoFile").value = "";
    renderProfilePhotoPreview($("profilePhotoUrl")?.value.trim() || "");
  });
}

function renderProfilePhotoPreview(value, ownedObjectUrl = "") {
  const image = $("profilePhotoPreviewImage");
  if (!image) return;
  if (state.profilePhotoPreviewUrl) URL.revokeObjectURL(state.profilePhotoPreviewUrl);
  state.profilePhotoPreviewUrl = ownedObjectUrl;
  const url = ownedObjectUrl || normalizePhotoUrl(value);
  image.hidden = !url;
  image.alt = url ? "Profile photo preview" : "";
  if (url) image.src = url;
  else image.removeAttribute("src");
  if ($("profilePhotoPreviewFallback")) {
    $("profilePhotoPreviewFallback").hidden = Boolean(url);
    $("profilePhotoPreviewFallback").textContent = url ? "" : "No photo selected";
  }
}

function setProfilePhotoStatus(message, isError = false) {
  const status = $("profilePhotoStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function resizeProfilePhoto(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_PROFILE_PHOTO_BYTES) {
    throw new Error("Choose a photo smaller than 10 MB.");
  }
  if (!("createImageBitmap" in window)) {
    throw new Error("This browser cannot resize the photo. Try a recent version of Chrome, Safari, or Firefox.");
  }

  const bitmap = await createImageBitmap(file);
  const maxEdge = 640;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    throw new Error("Could not prepare this photo in the browser.");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) throw new Error("Could not compress this photo. Try a different image.");
  return new File([blob], "profile-photo.jpg", { type: "image/jpeg" });
}

async function handleProfilePhotoSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (!isDriveStorageConfigured()) throw new Error("Google Drive upload setup is not finished yet. The selected photo was not uploaded.");
    setProfilePhotoStatus("Resizing photo in your browser…");
    if ($("profilePhotoProgress")) { $("profilePhotoProgress").hidden = true; $("profilePhotoProgress").value = 0; }
    const resized = await resizeProfilePhoto(file);
    state.profilePhotoFile = resized;
    $("profilePhotoUrl").value = "";
    renderProfilePhotoPreview("", URL.createObjectURL(resized));
    setProfilePhotoStatus(`Ready to upload (${Math.max(1, Math.round(resized.size / 1024))} KB after resizing).`);
  } catch (error) {
    state.profilePhotoFile = null;
    event.target.value = "";
    setProfilePhotoStatus(error.message || "Could not prepare this photo.", true);
  }
}

// Presentation only: roles still come from the existing Firebase member record.
const ROLE_ART = Object.freeze({
  admin: { symbol: "admin_panel_settings", caption: "Command centre", paths: '<rect x="22" y="22" width="28" height="28" rx="5"/><rect x="62" y="22" width="28" height="28" rx="5"/><rect x="22" y="62" width="28" height="28" rx="5"/><rect x="62" y="62" width="28" height="28" rx="5"/>' },
  leaders: { symbol: "trending_up", caption: "Lead the way", paths: '<path d="M24 88V72h18V54h18V36h18V18h18M26 54l54-34M64 20h16v16"/>' },
  public: { symbol: "groups", caption: "People & community", paths: '<circle cx="56" cy="35" r="12"/><circle cx="25" cy="48" r="9"/><circle cx="87" cy="48" r="9"/><path d="M35 90V76a21 21 0 0 1 42 0v14M12 87V76a13 13 0 0 1 19-12M100 87V76a13 13 0 0 0-19-12"/>' },
  tech: { symbol: "code", caption: "Build & connect", paths: '<rect x="12" y="18" width="88" height="67" rx="7"/><path d="M12 34h88M37 49l-12 11 12 11M75 49l12 11-12 11M62 46L50 75M39 96h34"/>' },
  social: { symbol: "tag", caption: "Stories that connect", paths: '<path d="M15 25h58v39H39L25 78V64H15zM83 42h14v43H80L66 98V85H49V74M28 40h31M28 51h20"/><circle cx="87" cy="21" r="9"/>' },
  designers: { symbol: "draw", caption: "Shape something new", paths: '<rect x="18" y="18" width="76" height="76" rx="2"/><path d="M18 56h76M56 18v76M32 76l36-36 12 12-36 36-16 4zM67 40l7-7 12 12-7 7"/><circle cx="36" cy="36" r="7"/>' },
  content: { symbol: "article", caption: "Words with purpose", paths: '<path d="M24 15h47l17 17v64H24zM71 15v19h17M36 48h40M36 60h40M36 72h26M36 84h19"/><path d="M14 36v42M9 36h10M9 78h10"/>' },
  event: { symbol: "calendar_month", caption: "Make it happen", paths: '<rect x="15" y="25" width="82" height="69" rx="7"/><path d="M15 44h82M33 16v18M79 16v18M33 62h10M56 62h10M79 62h4M33 80h10M56 80h10"/><path d="M77 76l5 5 10-12"/>' }
});

function roleDecorationMarkup(roleKey) {
  const art = ROLE_ART[roleKey];
  if (!art) return "";
  return `<div class="role-decoration" aria-hidden="true"><svg class="role-decoration-art" viewBox="0 0 112 112" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" focusable="false">${art.paths}</svg><span class="role-decoration-symbol material-symbols-outlined">${art.symbol}</span><span class="role-decoration-caption">${art.caption}</span></div>`;
}

function roleBackgroundMarkup(roleKey) {
  const art = ROLE_ART[roleKey];
  if (!art) return "";
  return `<div class="role-background" aria-hidden="true"><svg viewBox="0 0 1000 600" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" focusable="false"><g class="role-background-main" transform="translate(630 55) scale(2.8)">${art.paths}</g><g transform="translate(60 360) scale(1.5) rotate(-12 56 56)">${art.paths}</g><g transform="translate(420 430) scale(.8)">${art.paths}</g><path class="role-background-guide" stroke-dasharray="5 12" d="M30 310H970M570 25V575M610 25V575M30 350H970"/><path d="M600 70h20m-10-10v20M900 450h20m-10-10v20M300 480h20m-10-10v20"/></svg></div>`;
}

function decorateRoleSurface(surface, roleKey) {
  if (!surface) return;
  const role = ROLE_ART[roleKey] ? roleKey : "public";
  surface.dataset.roleTheme = role;
  surface.querySelector(":scope > .role-decoration")?.remove();
  surface.querySelector(":scope > .role-background")?.remove();
  surface.insertAdjacentHTML("afterbegin", roleBackgroundMarkup(role));
  surface.insertAdjacentHTML("beforeend", roleDecorationMarkup(role));
  const backdrop = surface.matches(".dashboard-hero, .profile-public-card") ? surface.closest("section") : null;
  if (backdrop) {
    backdrop.dataset.roleTheme = role;
    backdrop.classList.add("role-background-section");
    backdrop.querySelector(":scope > .role-background")?.remove();
    backdrop.insertAdjacentHTML("afterbegin", roleBackgroundMarkup(role));
  }
}

function addProfileSocialControls() {
  const form = $("profileForm");
  if (!form || $("profileSocialFields")) return;
  const save = form.querySelector('[type="submit"]');
  if (!save) return;
  save.insertAdjacentHTML("beforebegin", `<fieldset id="profileSocialFields" class="profile-social-fields"><legend>Social links</legend><div id="profileSocialPreview"></div><div class="two-col">${Object.entries(SOCIAL_PLATFORMS).map(([key, config]) => `<label>${config.label}<input type="url" id="social-${key}" maxlength="500" placeholder="https://${config.domains[0] || 'your-website.com'}/" autocomplete="off"></label>`).join("")}</div></fieldset>`);
  $("profileSocialFields").addEventListener("input", () => {
    const raw = Object.fromEntries(Object.keys(SOCIAL_PLATFORMS).map(key => [key, $("social-"+key)?.value || ""]));
    $("profileSocialPreview").innerHTML = socialLinksMarkup(raw);
  });
}

function updateProfileSummary() {
  if (!state.member || !state.user) return;
  decorateRoleSurface($("profilePanel"), state.role);
  const name = memberDisplayName(state.member, state.user);
  const level = levelForXp(state.member.xp);
  const publicProfileHref = `profile.html?uid=${encodeURIComponent(state.user.uid)}`;
  if ($("editPublicProfileButton")) $("editPublicProfileButton").href = publicProfileHref;
  if ($("profilePageLink")) $("profilePageLink").href = publicProfileHref;
  const avatar = $("teamAvatar");
  if (avatar) avatar.innerHTML = profileAvatarMarkup({ ...state.member, displayName: name }, "large");
  if ($("teamWelcome")) $("teamWelcome").textContent = `${name} · ${ROLE_CONFIG[state.role]?.label || state.role} · ${universityLabel(state.member.universityTag)}`;
  if ($("profileNameValue")) $("profileNameValue").textContent = name;
  if ($("profileRoleValue")) $("profileRoleValue").textContent = ROLE_CONFIG[state.role]?.label || state.role;
  if ($("profileXpValue")) $("profileXpValue").textContent = `${Number(state.member.xp) || 0} XP`;
  if ($("profileLevelValue")) $("profileLevelValue").textContent = `Level ${level}`;
  if ($("profileAnswersValue")) $("profileAnswersValue").textContent = String(Number(state.member.answersCount) || 0);
  if ($("profileTasksCompletedValue")) $("profileTasksCompletedValue").textContent = String(Number(state.member.tasksCompleted) || 0);
  if ($("profileDisplayName")) $("profileDisplayName").value = state.member.displayName || name;
  if ($("profilePhotoUrl")) $("profilePhotoUrl").value = state.member.photoURL || "";
  if ($("profileBio")) $("profileBio").value = state.member.bio || "";
  for (const key of Object.keys(SOCIAL_PLATFORMS)) {
    const input = $("social-"+key);
    if (input) input.value = state.member.socialLinks?.[key] || "";
  }
  if ($("profileSocialPreview")) $("profileSocialPreview").innerHTML = socialLinksMarkup(state.member.socialLinks);
  renderProfilePhotoPreview(profilePhotoDisplayUrl(state.member));
}

async function saveProfile(event) {
  event.preventDefault();
  if (!state.user || !state.member) return;
  const displayName = $("profileDisplayName")?.value.trim();
  const rawPhotoURL = $("profilePhotoUrl")?.value.trim() || "";
  let photoURL = normalizePhotoUrl(rawPhotoURL);
  const bio = $("profileBio")?.value.trim() || "";
  if (!displayName || displayName.length < 2) return showToast("Please enter a name with at least two characters.", "error");
  if (rawPhotoURL && !photoURL) return showToast("Use a valid http or https photo URL.", "error");
  let socialLinks;
  try {
    socialLinks = validateSocialLinks(Object.fromEntries(Object.keys(SOCIAL_PLATFORMS).map(key => [key, $("social-"+key)?.value || ""])));
  } catch (error) { return showToast(error.message, "error"); }
  const saveButton = $("saveProfileBtn");
  const oldPhotoDriveFileId = state.member.photoDriveFileId || "";
  let pendingPhotoDriveFileId = "";
  try {
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = state.profilePhotoFile ? "Uploading photo…" : "Saving…";
    }
    if (state.profilePhotoFile) {
      if (!isDriveStorageConfigured()) throw new Error("Google Drive upload setup is not finished yet.");
      const progress = $("profilePhotoProgress");
      if (progress) { progress.hidden = false; progress.value = 0; }
      setProfilePhotoStatus("Uploading your resized photo to Google Drive…");
      const uploaded = await uploadDriveFile(auth, state.profilePhotoFile, {
        category: "profile",
        sizeBytes: state.profilePhotoFile.size
      }, {
        onProgress: (percent) => {
          if (progress) progress.value = percent;
          setProfilePhotoStatus(`Uploading profile photo… ${percent}%`);
        }
      });
      if (!uploaded.id) throw new Error("The image uploaded, but Google Drive did not return its file ID.");
      pendingPhotoDriveFileId = uploaded.id;
      photoURL = driveProfilePhotoUrl(uploaded.id);
      if (!photoURL) throw new Error("Google Drive returned an invalid profile photo ID.");
      await updateDoc(doc(db, "teamMembers", state.user.uid), {
        displayName, photoURL, photoDriveFileId: uploaded.id,
        photoFileName: uploaded.fileName, photoMimeType: uploaded.mimeType,
        photoSizeBytes: uploaded.sizeBytes, photoUploadedByUid: state.user.uid,
        photoUploadedAt: serverTimestamp(), bio, socialLinks, updatedAt: serverTimestamp()
      });
      pendingPhotoDriveFileId = "";
      state.member = {
        ...state.member, displayName, photoURL, photoDriveFileId: uploaded.id,
        photoFileName: uploaded.fileName, photoMimeType: uploaded.mimeType,
        photoSizeBytes: uploaded.sizeBytes, photoUploadedByUid: state.user.uid,
        photoUploadedAt: new Date(), bio, socialLinks
      };
      state.profilePhotoFile = null;
      if ($("profilePhotoFile")) $("profilePhotoFile").value = "";
      updateProfileSummary();
      if (oldPhotoDriveFileId && oldPhotoDriveFileId !== uploaded.id) {
        try { await retireDriveProfilePhoto(auth, oldPhotoDriveFileId); }
        catch (_) { setProfilePhotoStatus("Photo updated. The previous Drive copy could not be removed automatically."); }
      }
      if ($("profilePhotoProgress")) $("profilePhotoProgress").hidden = true;
      setProfilePhotoStatus("Profile photo saved to Google Drive.");
      showToast("Your profile and photo were updated.");
      return;
    }
    const keepDrivePhoto = photoURL && photoURL === state.member.photoURL;
    const update = {
      displayName, photoURL, bio, socialLinks, updatedAt: serverTimestamp(),
      photoDriveFileId: keepDrivePhoto ? state.member.photoDriveFileId || "" : "",
      photoFileName: keepDrivePhoto ? state.member.photoFileName || "" : "",
      photoMimeType: keepDrivePhoto ? state.member.photoMimeType || "" : "",
      photoSizeBytes: keepDrivePhoto ? Number(state.member.photoSizeBytes) || 0 : 0,
      photoUploadedByUid: keepDrivePhoto ? state.member.photoUploadedByUid || "" : "",
      photoUploadedAt: keepDrivePhoto ? state.member.photoUploadedAt || "" : ""
    };
    await updateDoc(doc(db, "teamMembers", state.user.uid), update);
    state.member = { ...state.member, ...update, photoURL };
    if (!keepDrivePhoto && oldPhotoDriveFileId) {
      try { await retireDriveProfilePhoto(auth, oldPhotoDriveFileId); } catch (_) { /* A replaced image can be cleaned up later. */ }
    }
    state.profilePhotoFile = null;
    if ($("profilePhotoFile")) $("profilePhotoFile").value = "";
    updateProfileSummary();
    if ($("profilePhotoProgress")) $("profilePhotoProgress").hidden = true;
    setProfilePhotoStatus(photoURL ? "Profile photo saved." : "");
    showToast("Your profile was updated.");
  } catch (error) {
    if (pendingPhotoDriveFileId) {
      try { await retireDriveProfilePhoto(auth, pendingPhotoDriveFileId); } catch (_) { /* Keep the profile-save error visible. */ }
    }
    const message = pendingPhotoDriveFileId && isProfilePermissionDenied(error)
      ? "The photo reached Google Drive, but Firestore denied saving it to your profile. Publish the updated firestore.rules to the Firebase project used by this site, then try again."
      : profileWriteError(error, "your profile");
    setProfilePhotoStatus(message, true);
    showToast(message, "error");
  } finally {
    if ($("profilePhotoProgress")) $("profilePhotoProgress").hidden = true;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save profile";
    }
  }
}

function universityByTag(tag) {
  return UNIVERSITY_BY_TAG[String(tag || "").trim()] || null;
}

function universityLabel(tag) {
  const university = universityByTag(tag);
  return university ? `${university.name} · ${university.tag}` : "University not assigned";
}

function universityOptionsMarkup(selectedTag = "", includeBlank = true) {
  const blank = includeBlank ? `<option value="">Not assigned</option>` : "";
  return `${blank}${UNIVERSITY_OPTIONS.map((university) => `<option value="${escapeAttr(university.tag)}" ${university.tag === selectedTag ? "selected" : ""}>${escapeHtml(university.name)} · ${escapeHtml(university.tag)}</option>`).join("")}`;
}

function chatIdFor(memberUid, leaderUid) {
  return `${memberUid}__${leaderUid}`;
}

function chatMessageName(uid) {
  if (uid === state.user?.uid) return memberDisplayName(state.member, state.user);
  const profile = chatMessageProfile(uid);
  return memberDisplayName(profile || {}, { uid });
}

function chatMessageProfile(uid) {
  if (uid === state.user?.uid) return { ...state.member, uid };
  if (state.chatPartner?.uid === uid) return state.chatPartner;
  const thread = state.chatThreads.find((item) => item.memberUid === uid || item.leaderUid === uid);
  return thread?.memberProfile || thread || null;
}

function renderChatMessages() {
  if (!refs.chatMessages) return;
  const messages = state.chatMessages || [];
  refs.chatMessages.innerHTML = messages.length
    ? messages.map((message) => {
      const own = message.senderUid === state.user?.uid;
      const avatar = profileAvatarMarkup(chatMessageProfile(message.senderUid) || { uid: message.senderUid, displayName: message.senderName }, "small");
      const bubble = `<article class="chat-message ${own ? "is-own" : ""}"><div class="chat-message-meta"><strong>${escapeHtml(message.senderName || chatMessageName(message.senderUid))}</strong><span>${escapeHtml(formatDate(message.createdAt))}</span></div><p>${escapeHtml(message.text)}</p></article>`;
      return `<div class="chat-message-row ${own ? "is-own" : ""}">${own ? `${bubble}${avatar}` : `${avatar}${bubble}`}</div>`;
    }).join("")
    : `<div class="empty-state chat-empty-state">No messages yet. Send the first question.</div>`;
  refs.chatMessages.scrollTop = refs.chatMessages.scrollHeight;
}

function renderChatPanel() {
  if (!refs.chatPanel) return;
  const isLeader = state.role === "leaders";
  refs.chatPanel.classList.toggle("hidden", !state.isTeam || state.role === "admin" || (page === "admin" && state.activeDashboardSection !== "chat"));
  if (!state.isTeam || state.role === "admin") return;
  refs.chatConversationList?.classList.toggle("hidden", !isLeader);
  if (refs.chatPanelTitle) {
    const activeThread = state.chatThreads.find((thread) => thread.id === state.activeChatId);
    const chatProfile = isLeader ? activeThread?.memberProfile : state.chatPartner;
    const title = isLeader
      ? `Leader inbox · ${universityLabel(state.member?.leadingUniversityTag)}`
      : chatProfile ? `Chat with ${memberDisplayName(chatProfile)}` : "Chat with your university leader";
    refs.chatPanelTitle.innerHTML = `${chatProfile ? profileAvatarMarkup(chatProfile, "small") : ""}<span>${escapeHtml(title)}</span>`;
  }
  if (refs.chatPanelHint) {
    refs.chatPanelHint.textContent = isLeader
      ? "Reply to members assigned to your university. Chats are automatically deleted every day."
      : state.chatPartner
        ? "Ask your leader a question. This chat is automatically deleted every day."
        : "An admin has not assigned a leader to your university yet.";
  }
  if (isLeader && refs.chatConversationList) {
    refs.chatConversationList.innerHTML = state.chatThreads.length
      ? state.chatThreads.map((thread) => `<button type="button" class="chat-thread ${thread.id === state.activeChatId ? "active" : ""}" data-chat-thread="${escapeAttr(thread.id)}">${profileAvatarMarkup(thread.memberProfile || thread, "small")}<span class="chat-thread-copy"><strong>${escapeHtml(thread.memberName || "Team member")}</strong><small>${escapeHtml(thread.lastMessagePreview || "Open conversation")}</small></span></button>`).join("")
      : `<div class="empty-state chat-thread-empty">No member conversations yet.</div>`;
    refs.chatConversationList.querySelectorAll("[data-chat-thread]").forEach((button) => button.addEventListener("click", async () => {
      state.activeChatId = button.dataset.chatThread;
      renderChatPanel();
      await loadChatMessages(state.activeChatId);
    }));
  }
  const canSend = Boolean(state.activeChatId && (state.chatPartner || state.chatThreads.find((thread) => thread.id === state.activeChatId)));
  if (refs.chatForm) refs.chatForm.classList.toggle("hidden", !canSend);
  if (refs.chatSendButton) refs.chatSendButton.disabled = !canSend;
  renderChatMessages();
}

function clearChatMessageListener() {
  if (state.chatMessagesUnsubscribe) state.chatMessagesUnsubscribe();
  state.chatMessagesUnsubscribe = null;
  state.chatMessagesChatId = "";
}

function clearChatThreadListener() {
  if (state.chatThreadsUnsubscribe) state.chatThreadsUnsubscribe();
  state.chatThreadsUnsubscribe = null;
}

async function enrichLeaderChatProfiles(threads) {
  const profilesToLoad = threads.filter((thread) => (
    thread.memberUid
    && !Object.prototype.hasOwnProperty.call(state.chatProfiles, thread.memberUid)
  ));
  if (!profilesToLoad.length) return;
  await Promise.all(profilesToLoad.map(async (thread) => {
    try {
      const snapshot = await getDoc(doc(db, "teamMembers", thread.memberUid));
      state.chatProfiles[thread.memberUid] = snapshot.exists()
        ? { uid: snapshot.id, ...snapshot.data() }
        : null;
    } catch (_) {
      state.chatProfiles[thread.memberUid] = null;
    }
  }));
  state.chatThreads = state.chatThreads.map((thread) => ({
    ...thread,
    memberProfile: state.chatProfiles[thread.memberUid] || thread.memberProfile || null
  }));
  renderChatPanel();
}

function stopChatListeners() {
  clearChatMessageListener();
  clearChatThreadListener();
}

function loadChatMessages(chatId) {
  if (!chatId || !refs.chatMessages) return;
  if (state.chatMessagesChatId === chatId && state.chatMessagesUnsubscribe) return;
  clearChatMessageListener();
  state.chatMessagesChatId = chatId;
  state.chatMessages = [];
  refs.chatMessages.innerHTML = `<div class="empty-state chat-empty-state">Loading messages…</div>`;

  const attach = (targetQuery, allowFallback) => {
    state.chatMessagesUnsubscribe = onSnapshot(targetQuery, (snapshot) => {
      state.chatMessages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedAsc);
      renderChatPanel();
    }, (error) => {
      if (allowFallback) {
        attach(collection(db, "leaderChats", chatId, "messages"), false);
        return;
      }
      refs.chatMessages.innerHTML = `<div class="empty-state chat-empty-state">Messages could not be loaded.</div>`;
      showToast(firebaseError(error), "error");
    });
  };

  attach(query(collection(db, "leaderChats", chatId, "messages"), orderBy("createdAt", "asc")), true);
}

function subscribeToLeaderThreads() {
  clearChatThreadListener();
  const attach = (targetQuery, allowFallback) => {
    state.chatThreadsUnsubscribe = onSnapshot(targetQuery, (snapshot) => {
      const previousActiveChatId = state.activeChatId;
      state.chatThreads = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => sortByCreatedDesc(a, b, "lastMessageAt"));
      state.activeChatId = state.chatThreads.some((thread) => thread.id === previousActiveChatId)
        ? previousActiveChatId
        : state.chatThreads[0]?.id || "";
      renderChatPanel();
      if (state.activeChatId) loadChatMessages(state.activeChatId);
      else {
        clearChatMessageListener();
        state.chatMessages = [];
        renderChatPanel();
      }
      enrichLeaderChatProfiles(state.chatThreads);
    }, (error) => {
      if (allowFallback) {
        attach(query(collection(db, "leaderChats"), where("leaderUid", "==", state.user.uid)), false);
        return;
      }
      renderChatPanel();
      showToast(firebaseError(error), "error");
    });
  };

  attach(query(
    collection(db, "leaderChats"),
    where("leaderUid", "==", state.user.uid),
    orderBy("lastMessageAt", "desc")
  ), true);
}

async function loadMemberChat() {
  if (!state.isTeam || state.role === "admin" || !refs.chatPanel) return;
  state.chatPartner = null;
  state.chatThreads = [];
  state.activeChatId = "";
  state.chatMessages = [];
  state.chatProfiles = {};
  stopChatListeners();
  if (state.role === "leaders") {
    subscribeToLeaderThreads();
    return;
  }
  const universityTag = String(state.member?.universityTag || "").trim();
  if (!universityByTag(universityTag)) {
    renderChatPanel();
    return;
  }
  try {
    let snapshot;
    try {
      snapshot = await getDocs(query(
        collection(db, "teamMembers"),
        where("role", "==", "leaders"),
        where("active", "==", true),
        where("leadingUniversityTag", "==", universityTag)
      ));
    } catch (_) {
      snapshot = await getDocs(query(collection(db, "teamMembers"), where("role", "==", "leaders"), where("active", "==", true)));
    }
    const leaders = snapshot.docs
      .map((item) => ({ uid: item.id, ...item.data() }))
      .filter((leader) => leader.leadingUniversityTag === universityTag);
    state.chatPartner = leaders[0] || null;
    state.activeChatId = state.chatPartner ? chatIdFor(state.user.uid, state.chatPartner.uid) : "";
    renderChatPanel();
    if (state.activeChatId) await loadChatMessages(state.activeChatId);
  } catch (error) {
    renderChatPanel();
    showToast(firebaseError(error), "error");
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  const text = refs.chatInput?.value.trim();
  if (!text || text.length > 2000) return showToast("Write a message between 1 and 2,000 characters.", "error");
  if (state.role !== "leaders" && (!state.chatPartner || !state.activeChatId)) {
    await loadMemberChat();
  }
  const thread = state.chatThreads.find((item) => item.id === state.activeChatId);
  const leader = state.role === "leaders" ? state.member : state.chatPartner;
  const member = state.role === "leaders" ? {
    uid: thread?.memberUid,
    displayName: thread?.memberName || "Team member",
    universityTag: thread?.universityTag || state.member?.leadingUniversityTag
  } : state.member;
  if (!leader?.uid || !member?.uid || !state.activeChatId) {
    if (state.role === "leaders") return showToast("Select a member conversation before sending a reply.", "error");
    if (!state.member?.universityTag) return showToast("An admin must assign your university before you can message its leader.", "error");
    return showToast("No active leader is assigned to your university yet.", "error");
  }
  const chatId = state.activeChatId;
  const chatRef = doc(db, "leaderChats", chatId);
  const messageRef = collection(db, "leaderChats", chatId, "messages");
  const commonChatData = {
    memberUid: member.uid,
    memberName: memberDisplayName(member),
    leaderUid: leader.uid,
    leaderName: memberDisplayName(leader),
    universityTag: member.universityTag || state.member?.leadingUniversityTag || "",
    universityName: universityByTag(member.universityTag || state.member?.leadingUniversityTag)?.name || "",
    lastMessagePreview: text.slice(0, 160),
    lastSenderUid: state.user.uid,
    lastMessageAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  try {
    // Merge works for both the first message (create) and later messages
    // (update), so a member never needs read access to a nonexistent chat doc.
    await setDoc(chatRef, commonChatData, { merge: true });
    const newMessageRef = doc(messageRef);
    const recipientUid = state.user.uid === leader.uid ? member.uid : leader.uid;
    const batch = writeBatch(db);
    batch.set(newMessageRef, {
      text,
      senderUid: state.user.uid,
      senderName: memberDisplayName(state.member, state.user),
      createdAt: serverTimestamp()
    });
    batch.set(doc(db, "teamMembers", recipientUid, "notifications", `chat_${chatId}_${newMessageRef.id}`),
      inboxNotificationData("chat_message", "New message in your leader chat",
        `${memberDisplayName(state.member, state.user)} sent you a message. Open leader chat to read it.`,
        { chatId, chatMessageId: newMessageRef.id }));
    await batch.commit();
    refs.chatInput.value = "";
    await loadMemberChat();
    showToast("Message sent.");
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function loadTeamMembers() {
  if (!state.isTeam || !(canReadAllTeam() || ["admin", "leaders"].includes(state.role) || currentTeamLeadRoles().length)) return;
  try {
    let memberDocuments;
    if (canReadAllTeam()) {
      const activeDocuments = (await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)))).docs;
      const inactiveDocuments = state.role === "admin"
        ? (await getDocs(query(collection(db, "teamMembers"), where("active", "==", false)))).docs
        : [];
      memberDocuments = [...new Map([...activeDocuments, ...inactiveDocuments].map((item) => [item.id, item])).values()];
    } else {
      const universityTag = taskLeaderUniversityTag();
      const hasUniversityScope = state.role === "leaders" && Boolean(universityByTag(universityTag));
      const teamLeadRoles = currentTeamLeadRoles();
      if (!hasUniversityScope && !teamLeadRoles.length) {
        state.teamMembers = [];
        renderTeamMembers();
        return;
      }
      const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
      memberDocuments = snapshot.docs.filter((item) => {
        const data = item.data();
        return data.role !== "admin"
          && (teamLeadRoles.includes(data.role) || (hasUniversityScope && data.universityTag === universityTag));
      });
    }
    const ratingDocuments = canReadAllRatings()
      ? (await getDocs(collection(db, "memberRatings"))).docs
      : await Promise.all(memberDocuments
        .filter((item) => canManageMember({ uid: item.id, ...item.data() }))
        .map((item) => getDoc(doc(db, "memberRatings", item.id))));
    const ratingByUid = new Map(ratingDocuments
      .filter((item) => item.exists())
      .map((item) => [item.id, item.data()]));
    state.teamMembers = memberDocuments
      .map((item) => ({ uid: item.id, ...item.data() }))
      .filter((member) => (member.active !== false || state.role === "admin")
        && (state.role === "admin" || member.uid !== state.user?.uid))
      .map((member) => ({
        ...member,
        ratingScores: ratingByUid.get(member.uid)?.scores || {},
        ratingNotes: ratingByUid.get(member.uid)?.notes || {}
      }))
      .sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
    renderTeamMembers();
    renderLeaderboard();
  } catch (error) {
    refs.teamMembersList.innerHTML = `<div class="empty-state">Team profiles could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function attendanceDate(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : value?.seconds ? new Date(value.seconds * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function attendanceTimeZone(value) {
  const zone = String(value || "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch (_) {
    return "UTC";
  }
}

function attendanceLocalTime(value, timeZone = "UTC") {
  const date = attendanceDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: attendanceTimeZone(timeZone), timeZoneName: "short", hour12: false
  }).format(date);
}

function attendanceDuration(visits, now = Date.now()) {
  const intervals = visits.map((visit) => {
    const start = attendanceDate(visit.enteredAt)?.getTime();
    if (!Number.isFinite(start)) return null;
    const end = attendanceDate(visit.leftAt)?.getTime() ?? now;
    return [start, Math.max(start, end)];
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
  let seconds = 0;
  let rangeStart = null;
  let rangeEnd = null;
  for (const [start, end] of intervals) {
    if (rangeStart === null) {
      rangeStart = start;
      rangeEnd = end;
    } else if (start <= rangeEnd) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      seconds += rangeEnd - rangeStart;
      rangeStart = start;
      rangeEnd = end;
    }
  }
  if (rangeStart !== null) seconds += rangeEnd - rangeStart;
  return Math.floor(seconds / 1000);
}

function attendanceDurationLabel(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function attendanceStatusFor(memberVisits, session) {
  if (memberVisits.length) return "attended";
  if (session.status === "ended") return "absent";
  if (session.status === "cancelled") return "cancelled";
  return "pending";
}

function attendanceStatusLabel(status) {
  return ({
    attended: "Attended",
    absent: "Absent",
    excused: "Excused",
    pending: "Not joined yet",
    cancelled: "Session cancelled",
    auto: "Automatic"
  })[status] || status;
}

function sessionQueriesForMember(base, member) {
  if (member?.role === "admin") return [base];
  return [
    query(base,
      where("audienceRole", "in", ["all", member.role]),
      where("audienceUniversityTag", "in", [...new Set(["", member.universityTag || ""])])),
    query(base, where("audienceRole", "==", "targeted"), where("targetMemberUids", "array-contains", member.uid))
  ];
}

function mergeMemberSessions(snapshots, member) {
  const unique = new Map();
  snapshots.flatMap((snapshot) => snapshot.docs).forEach((item) => unique.set(item.id, { id: item.id, ...item.data() }));
  return [...unique.values()]
    .filter((session) => member?.role === "admin" || isSessionForMember({ ...session, status: "scheduled" }, member));
}

async function loadAttendanceSessions() {
  if (!canReadAttendance() || !refs.attendanceSessionSelect) return;
  refs.attendanceTableRoot.innerHTML = `<div class="empty-state">Loading NawrasOnline sessions…</div>`;
  try {
    const base = collection(db, "nawrasOnlineSessions");
    const snapshots = await Promise.all(sessionQueriesForMember(base, state.member).map((ref) => getDocs(ref)));
    state.attendanceSessions = mergeMemberSessions(snapshots, state.member)
      .sort((a, b) => (attendanceDate(b.startsAt)?.getTime() || 0) - (attendanceDate(a.startsAt)?.getTime() || 0));
    if (!state.attendanceSessions.length) {
      refs.attendanceSessionSelect.innerHTML = `<option value="">No sessions found</option>`;
      refs.attendanceSessionMeta.textContent = "Create a NawrasOnline room to start collecting attendance.";
      refs.attendanceTableRoot.innerHTML = `<div class="empty-state">No NawrasOnline sessions are available.</div>`;
      refs.exportAttendanceBtn.disabled = true;
      return;
    }
    refs.attendanceSessionSelect.innerHTML = state.attendanceSessions.map((session) => {
      const title = session.title || "Video session";
      const date = attendanceDate(session.startsAt);
      const dateText = date ? attendanceLocalTime(date, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") : "Date not set";
      return `<option value="${escapeAttr(session.id)}">${escapeHtml(title)} · ${escapeHtml(dateText)} · ${escapeHtml(session.status || "unknown")}</option>`;
    }).join("");
    refs.attendanceSessionSelect.onchange = () => { void loadAttendanceSession(refs.attendanceSessionSelect.value); };
    const firstSession = state.attendanceSessions.find((session) => session.status === "live")
      || state.attendanceSessions.find((session) => session.status === "ended")
      || state.attendanceSessions[0];
    refs.attendanceSessionSelect.value = firstSession.id;
    await loadAttendanceSession(firstSession.id);
  } catch (error) {
    refs.attendanceTableRoot.innerHTML = `<div class="empty-state">Attendance sessions could not be loaded. Deploy the updated Firestore rules and try again.</div>`;
    refs.attendanceSessionMeta.textContent = "Admin access to NawrasOnline sessions is required.";
    refs.exportAttendanceBtn.disabled = true;
    showToast(firebaseError(error), "error");
  }
}

async function loadAttendanceSession(sessionId) {
  if (!canReadAttendance() || !sessionId) return;
  const session = state.attendanceSessions.find((item) => item.id === sessionId);
  if (!session) return;
  state.attendanceSession = session;
  refs.attendanceTableRoot.innerHTML = `<div class="empty-state">Loading attendance records…</div>`;
  refs.attendanceSessionMeta.textContent = `${session.status || "unknown"} session · Loading records`;
  refs.exportAttendanceBtn.disabled = true;
  try {
    const [visitSnapshot, overrideSnapshot] = await Promise.all([
      getDocs(collection(db, "nawrasOnlineSessions", sessionId, "attendanceVisits")),
      getDocs(collection(db, "nawrasOnlineSessions", sessionId, "attendance"))
    ]);
    if (state.attendanceSession?.id !== sessionId) return;
    state.attendanceVisits = visitSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    state.attendanceOverrides = new Map(overrideSnapshot.docs.map((item) => [item.id, item.data()]));
    renderAttendanceRows();
  } catch (error) {
    if (state.attendanceSession?.id !== sessionId) return;
    refs.attendanceTableRoot.innerHTML = `<div class="empty-state">Could not load this session’s records. Confirm the updated Firestore rules are deployed.</div>`;
    refs.attendanceSessionMeta.textContent = "Attendance records are available to admins only.";
    refs.exportAttendanceBtn.disabled = true;
    showToast(firebaseError(error), "error");
  }
}

function renderAttendanceRows() {
  const session = state.attendanceSession;
  if (!session || !refs.attendanceTableRoot) return;
  const audienceRole = session.audienceRole || "all";
  const audienceUniversityTag = session.audienceUniversityTag || "";
  const roster = state.teamMembers.filter((member) =>
    member.active === true
    && ((Array.isArray(session.targetMemberUids) && session.targetMemberUids.includes(member.uid))
      || ((audienceRole === "all" || member.role === audienceRole)
        && (!audienceUniversityTag || member.universityTag === audienceUniversityTag)))
  );
  const visitsByUid = new Map();
  state.attendanceVisits.forEach((visit) => {
    if (!visit.uid) return;
    if (!visitsByUid.has(visit.uid)) visitsByUid.set(visit.uid, []);
    visitsByUid.get(visit.uid).push(visit);
  });
  const profileByUid = new Map(state.teamMembers.map((member) => [member.uid, member]));
  const membersByUid = new Map(roster.map((member) => [member.uid, member]));
  visitsByUid.forEach((visits, uid) => {
    if (!membersByUid.has(uid)) {
      const visit = visits[0] || {};
      membersByUid.set(uid, profileByUid.get(uid) || { uid, displayName: visit.displayName || "Former member", active: false });
    }
  });
  state.attendanceOverrides.forEach((_override, uid) => {
    if (!membersByUid.has(uid)) membersByUid.set(uid, profileByUid.get(uid) || { uid, displayName: "Former member", active: false });
  });

  const now = Date.now();
  state.attendanceRows = [...membersByUid.values()]
    .map((member) => {
      const visits = (visitsByUid.get(member.uid) || []).sort((a, b) =>
        (attendanceDate(a.enteredAt)?.getTime() || 0) - (attendanceDate(b.enteredAt)?.getTime() || 0)
      );
      const firstVisit = visits.find((visit) => attendanceDate(visit.enteredAt)) || null;
      const completedVisits = visits.filter((visit) => attendanceDate(visit.leftAt));
      const latestExitVisit = completedVisits.reduce((latest, visit) =>
        !latest || attendanceDate(visit.leftAt).getTime() > attendanceDate(latest.leftAt).getTime() ? visit : latest, null
      );
      const automaticStatus = attendanceStatusFor(visits, session);
      const override = state.attendanceOverrides.get(member.uid) || {};
      const status = override.statusOverride && override.statusOverride !== "auto"
        ? override.statusOverride
        : automaticStatus;
      const email = member.email || visits.find((visit) => visit.email)?.email || "";
      return {
        uid: member.uid,
        name: String(member.displayName || visits[0]?.displayName || member.email || "Team member"),
        email,
        visits,
        firstVisit,
        latestExitVisit,
        hasOpenVisit: visits.some((visit) => !visit.leftAt),
        durationSeconds: attendanceDuration(visits, now),
        automaticStatus,
        status,
        statusOverride: override.statusOverride || "auto",
        notes: String(override.notes || "")
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const activeCount = state.attendanceRows.filter((row) => row.visits.length).length;
  refs.attendanceSessionMeta.textContent = `${session.status || "unknown"} session · ${state.attendanceRows.length} eligible participant${state.attendanceRows.length === 1 ? "" : "s"} · ${activeCount} joined · Times are shown in each visit’s recorded timezone.`;
  refs.exportAttendanceBtn.disabled = false;
  if (!state.attendanceRows.length) {
    refs.attendanceTableRoot.innerHTML = `<div class="empty-state">No active accounts match this session’s audience.</div>`;
    return;
  }
  const rows = state.attendanceRows.map((row) => {
    const firstTime = row.firstVisit
      ? attendanceLocalTime(row.firstVisit.enteredAt, row.firstVisit.timeZone)
      : "—";
    const exitTime = row.hasOpenVisit
      ? "Still open"
      : row.latestExitVisit
        ? attendanceLocalTime(row.latestExitVisit.leftAt, row.latestExitVisit.timeZone)
        : "—";
    const automaticLabel = attendanceStatusLabel(row.automaticStatus);
    return `<tr data-attendance-row="${escapeAttr(row.uid)}">
      <td><strong>${escapeHtml(row.name)}</strong><small class="attendance-subvalue">${escapeHtml(row.uid)}</small></td>
      <td>${row.email ? escapeHtml(row.email) : `<span class="attendance-email-missing">Not available in member profile</span>`}</td>
      <td>${escapeHtml(firstTime)}</td>
      <td>${escapeHtml(exitTime)}</td>
      <td><strong>${attendanceDurationLabel(row.durationSeconds)}</strong></td>
      <td><span class="attendance-status-badge attendance-status-${escapeAttr(row.status)}">${escapeHtml(attendanceStatusLabel(row.status))}</span><small class="attendance-subvalue">Auto: ${escapeHtml(automaticLabel)}</small></td>
      <td><select data-attendance-status aria-label="Attendance status for ${escapeAttr(row.name)}">
        <option value="auto" ${row.statusOverride === "auto" ? "selected" : ""}>Automatic</option>
        <option value="attended" ${row.statusOverride === "attended" ? "selected" : ""}>Attended</option>
        <option value="absent" ${row.statusOverride === "absent" ? "selected" : ""}>Absent</option>
        <option value="excused" ${row.statusOverride === "excused" ? "selected" : ""}>Excused</option>
      </select></td>
      <td><textarea data-attendance-notes maxlength="2000" rows="2" aria-label="Admin notes for ${escapeAttr(row.name)}" placeholder="Add a note">${escapeHtml(row.notes)}</textarea><button class="btn btn-outline btn-compact attendance-save-button" type="button" data-attendance-save="${escapeAttr(row.uid)}">Save status &amp; note</button></td>
    </tr>`;
  }).join("");
  refs.attendanceTableRoot.innerHTML = `<div class="answer-table-wrap attendance-table-wrap"><table class="answer-table attendance-table"><thead><tr><th>Participant</th><th>Email</th><th>First entry</th><th>Latest exit</th><th>Total time</th><th>Attendance</th><th>Admin status</th><th>Admin notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  if (!canManageAttendance()) {
    refs.attendanceTableRoot.querySelectorAll("select,textarea").forEach((input) => { input.disabled = true; });
    refs.attendanceTableRoot.querySelectorAll("[data-attendance-save]").forEach((button) => button.remove());
  }
}

async function saveAttendanceOverride(button) {
  if (!canManageAttendance() || !state.attendanceSession) return showToast("Attendance management access is required.", "error");
  const row = button.closest("[data-attendance-row]");
  const uid = button.dataset.attendanceSave;
  const sessionId = state.attendanceSession.id;
  const statusOverride = row?.querySelector("[data-attendance-status]")?.value || "auto";
  const notes = row?.querySelector("[data-attendance-notes]")?.value || "";
  if (notes.length > 2000) return showToast("Notes must be 2,000 characters or fewer.", "error");
  button.disabled = true;
  try {
    const override = {
      uid,
      statusOverride,
      notes,
      updatedBy: state.user.uid,
      updatedAt: serverTimestamp()
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "nawrasOnlineSessions", sessionId, "attendance", uid), override, { merge: true });
    batch.set(doc(collection(db, "teamMembers", uid, "notifications")), inboxNotificationData(
      "attendance_update", "Your attendance was updated",
      `Attendance for ${state.attendanceSession.title || "your session"} was updated. Status: ${statusOverride === "auto" ? "automatic attendance" : statusOverride}.`,
      { sessionId }
    ));
    await batch.commit();
    if (state.attendanceSession?.id === sessionId) {
      state.attendanceOverrides.set(uid, { ...override, updatedAt: new Date() });
      renderAttendanceRows();
    }
    showToast("Attendance status and note saved.");
  } catch (error) {
    showToast(firebaseError(error), "error");
    button.disabled = false;
  }
}

function xmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function excelCell(value, numeric = false, header = false) {
  const style = header ? ` ss:StyleID="Header"` : "";
  return `<Cell${style}><Data ss:Type="${numeric ? "Number" : "String"}">${xmlEscape(value)}</Data></Cell>`;
}

function excelRow(values, header = false) {
  return `<Row>${values.map((value) => Array.isArray(value)
    ? excelCell(value[0], value[1], header)
    : excelCell(value, false, header)).join("")}</Row>`;
}

function exportAttendanceExcel() {
  if (!canReadAttendance() || !state.attendanceSession) return;
  const session = state.attendanceSession;
  const sessionName = session.title || "NawrasOnline session";
  const now = new Date();
  const summaryRows = [[
    "Participant", "Email", "User ID", "First entry (local time)", "Latest exit (local time)",
    "First entry (UTC)", "Latest exit (UTC)", "Timezone(s)", "Total time (HH:MM:SS)",
    "Total seconds", "Attendance status", "Automatic status", "Admin notes",
    "Session", "Session status", "Exported at (UTC)"
  ]];
  state.attendanceRows.forEach((row) => {
    const zones = [...new Set(row.visits.map((visit) => attendanceTimeZone(visit.timeZone)))];
    const entryDate = attendanceDate(row.firstVisit?.enteredAt);
    const exitDate = attendanceDate(row.latestExitVisit?.leftAt);
    summaryRows.push([
      row.name,
      row.email || "Not available in member profile",
      row.uid,
      entryDate ? attendanceLocalTime(entryDate, row.firstVisit.timeZone) : "—",
      row.hasOpenVisit ? "Still open" : exitDate ? attendanceLocalTime(exitDate, row.latestExitVisit.timeZone) : "—",
      entryDate ? entryDate.toISOString() : "—",
      row.hasOpenVisit ? "Still open" : exitDate ? exitDate.toISOString() : "—",
      zones.length ? zones.join(", ") : "No visit timezone",
      attendanceDurationLabel(row.durationSeconds),
      [row.durationSeconds, true],
      attendanceStatusLabel(row.status),
      attendanceStatusLabel(row.automaticStatus),
      row.notes,
      sessionName,
      session.status || "unknown",
      now.toISOString()
    ]);
  });
  const visitRows = [[
    "Session", "Session ID", "Participant", "Email", "User ID", "Visit number",
    "Entry (local time)", "Exit (local time)", "Entry (UTC)", "Exit (UTC)",
    "Timezone (IANA)", "Duration (HH:MM:SS)", "Duration seconds"
  ]];
  const allVisits = state.attendanceRows.flatMap((row) => row.visits.map((visit, index) => ({ row, visit, index })))
    .sort((a, b) => (attendanceDate(a.visit.enteredAt)?.getTime() || 0) - (attendanceDate(b.visit.enteredAt)?.getTime() || 0));
  allVisits.forEach(({ row, visit, index }) => {
    const enteredAt = attendanceDate(visit.enteredAt);
    const leftAt = attendanceDate(visit.leftAt);
    const elapsed = attendanceDuration([visit], now.getTime());
    visitRows.push([
      sessionName, session.id, row.name, visit.email || row.email || "Not available in member profile",
      row.uid, String(index + 1),
      enteredAt ? attendanceLocalTime(enteredAt, visit.timeZone) : "—",
      leftAt ? attendanceLocalTime(leftAt, visit.timeZone) : "Still open",
      enteredAt ? enteredAt.toISOString() : "—",
      leftAt ? leftAt.toISOString() : "Still open",
      attendanceTimeZone(visit.timeZone),
      attendanceDurationLabel(elapsed),
      [elapsed, true]
    ]);
  });
  const worksheet = (name, rows) => `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${rows.map((row, index) => excelRow(row, index === 0)).join("")}</Table></Worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:html="http://www.w3.org/TR/REC-html40">
<Styles><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#17324f"/><Interior ss:Color="#eaf1f8" ss:Pattern="Solid"/></Style></Styles>
${worksheet("Attendance Summary", summaryRows)}
${worksheet("Individual Visits", visitRows)}
</Workbook>`;
  const blob = new Blob(["\uFEFF", workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilename(sessionName)}-attendance.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

refs.attendanceTableRoot?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-attendance-save]");
  if (button) void saveAttendanceOverride(button);
});
refs.exportAttendanceBtn?.addEventListener("click", exportAttendanceExcel);

function leaderboardRole() {
  return state.role === "admin" || currentTeamLeadRoles().includes(state.activeDashboardRole)
    ? (state.activeDashboardRole || state.role)
    : state.role;
}

async function loadLeaderboard() {
  if (!state.isTeam || !refs.leaderboardList) return;
  const role = leaderboardRole();
  if (role === "admin" && state.role === "admin") {
    state.leaderboardMembers = state.teamMembers.filter((member) => member.active !== false);
    renderLeaderboard();
    return;
  }
  const scopedUniversityTag = state.role === "leaders" && role === "leaders"
    ? String(state.member?.leadingUniversityTag || "").trim()
    : "";
  if (state.role === "leaders" && !universityByTag(scopedUniversityTag)) {
    state.leaderboardMembers = [];
    renderLeaderboard();
    return;
  }
  refs.leaderboardList.innerHTML = `<div class="empty-state">Loading leaderboard…</div>`;
  try {
    const base = collection(db, "teamMembers");
    let snapshot;
    try {
      snapshot = scopedUniversityTag
        ? await getDocs(query(base, where("active", "==", true), where("universityTag", "==", scopedUniversityTag), orderBy("xp", "desc")))
        : await getDocs(query(base, where("role", "==", role), where("active", "==", true), orderBy("xp", "desc")));
    } catch (_) {
      snapshot = scopedUniversityTag
        ? await getDocs(query(base, where("active", "==", true), where("universityTag", "==", scopedUniversityTag)))
        : await getDocs(query(base, where("role", "==", role), where("active", "==", true)));
    }
    state.leaderboardMembers = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }));
    renderLeaderboard();
  } catch (error) {
    refs.leaderboardList.innerHTML = `<div class="empty-state">Leaderboard could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function renderLeaderboard() {
  if (!refs.leaderboardList) return;
  const role = leaderboardRole();
  const scopedUniversityTag = state.role === "leaders" && role === "leaders"
    ? String(state.member?.leadingUniversityTag || "").trim()
    : "";
  const members = [...state.leaderboardMembers]
    .filter((member) => member.active !== false
      && (role === "admin" || (scopedUniversityTag ? member.role !== "admin" : member.role === role))
      && (!scopedUniversityTag || member.universityTag === scopedUniversityTag))
    .sort((a, b) => (Number(b.xp) || 0) - (Number(a.xp) || 0)
      || (Number(b.tasksCompleted) || 0) - (Number(a.tasksCompleted) || 0)
      || memberDisplayName(a).localeCompare(memberDisplayName(b)));
  const teamLabel = scopedUniversityTag
    ? `${universityLabel(scopedUniversityTag)} team`
    : role === "admin" ? "all teams" : `${ROLE_CONFIG[role]?.label || role} team`;
  if (refs.leaderboardTitle) refs.leaderboardTitle.textContent = scopedUniversityTag
    ? `${universityByTag(scopedUniversityTag).tag} team leaderboard`
    : role === "admin" ? "All teams leaderboard" : `${ROLE_CONFIG[role]?.label || "Team"} leaderboard`;
  if (refs.leaderboardHint) refs.leaderboardHint.textContent = `${members.length} active member${members.length === 1 ? "" : "s"} · Ranked by XP${scopedUniversityTag ? ` · ${universityByTag(scopedUniversityTag).name}` : ""}`;
  refs.leaderboardList.innerHTML = members.length
    ? members.map((member, index) => `<article class="leaderboard-row ${member.uid === state.user?.uid ? "is-current-user" : ""}"><span class="leaderboard-rank">${index + 1}</span><div class="leaderboard-identity">${profileIdentityMarkup(member)}<small class="university-member-tag">${escapeHtml(universityLabel(member.universityTag))}</small></div><div class="leaderboard-stats"><span><strong>${Number(member.xp) || 0}</strong>XP</span><span><strong>${levelForXp(member.xp)}</strong>Level</span><span><strong>${Number(member.tasksCompleted) || 0}</strong>Tasks</span></div>${leaderboardGrantXpMarkup(member)}</article>`).join("")
    : `<div class="empty-state">No active members found for the ${escapeHtml(teamLabel)} leaderboard.</div>`;
  refs.leaderboardList.querySelectorAll("[data-adjust-xp]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    adjustXp(form.dataset.adjustXp, form.querySelector("[name=amount]")?.value, form.querySelector("[name=direction]")?.value, form.querySelector("[name=reason]")?.value);
  }));
}

function currentTeamLeadRoles() {
  return Array.isArray(state.member?.teamLeadRoles)
    ? [...new Set(state.member.teamLeadRoles.filter((role) => ASSIGNABLE_DASHBOARD_ROLES.includes(role)))]
    : [];
}

function adminTeamAssignment(member) {
  if (member?.role !== "admin") return null;
  const parts = String(member.adminTeamAssignment || "").split(":");
  if (parts.length !== 2) return null;
  const [position, role] = parts;
  return ["member", "leader"].includes(position) && ASSIGNABLE_DASHBOARD_ROLES.includes(role)
    ? { position, role }
    : null;
}

function belongsToTeam(member, roleKey) {
  return member?.role === roleKey || adminTeamAssignment(member)?.role === roleKey;
}

function adminTeamAssignmentOptions(value = "") {
  const options = [`<option value="">Not assigned to a team</option>`];
  for (const position of ["member", "leader"]) {
    const title = position === "member" ? "Team member" : "Team leader";
    options.push(`<optgroup label="${title}">${ASSIGNABLE_DASHBOARD_ROLES.map((role) => {
      const key = `${position}:${role}`;
      return `<option value="${key}" ${value === key ? "selected" : ""}>${escapeHtml(ROLE_CONFIG[role].label)}</option>`;
    }).join("")}</optgroup>`);
  }
  return options.join("");
}

function canManageMember(member, capability = "") {
  if (state.role === "admin") return true;
  if (!member || member.uid === state.user?.uid || member.active === false || member.role === "admin") return false;
  if (capability && hasDashboardAccess(capability)) return true;
  const universityScope = state.role === "leaders"
    && Boolean(state.member?.leadingUniversityTag)
    && member.universityTag === state.member.leadingUniversityTag;
  const roleScope = currentTeamLeadRoles().includes(member.role);
  return universityScope || roleScope;
}

function xpAdjustmentMarkup(member, className = "grant-xp-form") {
  if (!canManageMember(member, "xpManage")) return "";
  return `<form class="${className} xp-adjustment-form" data-adjust-xp="${escapeAttr(member.uid)}">
    <label>Change<select name="direction"><option value="add">Add XP</option><option value="subtract">Subtract XP</option></select></label>
    <label>Amount<input name="amount" type="number" min="1" max="100000" step="1" value="50" required></label>
    <label>Reason<input name="reason" type="text" maxlength="500" placeholder="Required: why?" required></label>
    <button class="btn btn-secondary btn-compact" type="submit">Save XP</button>
  </form>`;
}

function leaderboardGrantXpMarkup(member) {
  return xpAdjustmentMarkup(member, "leaderboard-grant-xp-form");
}

function renderTeamMembers() {
  if (!refs.teamMembersList) return;
  const selectedRoleLead = !canReadAllTeam() && currentTeamLeadRoles().includes(state.activeDashboardRole)
    ? state.activeDashboardRole : "";
  const groups = ROLE_ORDER.filter((roleKey) => !selectedRoleLead || roleKey === selectedRoleLead).map((roleKey) => ({
    roleKey,
    members: state.teamMembers.filter((member) => belongsToTeam(member, roleKey))
  })).filter((group) => group.members.length);
  refs.teamMembersList.innerHTML = groups.length
    ? groups.map((group) => `<section class="team-member-group"><div class="team-group-heading"><span class="team-group-icon" aria-hidden="true">${materialIcon("groups")}</span><div><h3>${escapeHtml(ROLE_CONFIG[group.roleKey].label)} team</h3><span>${group.members.length} member${group.members.length === 1 ? "" : "s"}</span></div></div><div class="team-group-list">${group.members.map((member) => {
      const level = levelForXp(member.xp);
      const assignedAdminTeam = adminTeamAssignment(member);
      const role = member.role === "admin" && assignedAdminTeam
        ? `Admin · ${assignedAdminTeam.position === "leader" ? "Team leader" : "Team member"}`
        : (ROLE_CONFIG[member.role]?.label || member.role || "Team member");
      const university = universityByTag(member.universityTag);
      const roleOptions = ASSIGNABLE_DASHBOARD_ROLES.map((roleKey) => `<option value="${roleKey}" ${member.role === roleKey ? "selected" : ""}>${escapeHtml(ROLE_CONFIG[roleKey].label)}</option>`).join("");
      const dashboardRoles = Array.isArray(member.dashboardRoles) && member.dashboardRoles.length
        ? member.dashboardRoles
        : ["user"];
      const dashboardAssignmentMarkup = `<fieldset class="dashboard-assignment-fieldset" data-dashboard-assignment ${member.role === "user" ? "" : "hidden"}><legend>Dashboard access for this User</legend><div class="dashboard-assignment-options">${ASSIGNABLE_DASHBOARD_ROLES.map((roleKey) => `<label class="check-row"><input type="checkbox" name="dashboardRoles" value="${roleKey}" ${dashboardRoles.includes(roleKey) ? "checked" : ""}><span>${escapeHtml(ROLE_CONFIG[roleKey].label)}</span></label>`).join("")}</div><small>Choose the dashboard views this account can open.</small></fieldset>`;
      const teamLeadRoles = Array.isArray(member.teamLeadRoles) ? member.teamLeadRoles : [];
       const teamLeadAssignmentMarkup = `<fieldset class="dashboard-assignment-fieldset" data-team-lead-assignment><legend>Position-leader appointments</legend><div class="dashboard-assignment-options">${ASSIGNABLE_DASHBOARD_ROLES.map((roleKey) => `<label class="check-row"><input type="checkbox" name="teamLeadRoles" value="${roleKey}" ${teamLeadRoles.includes(roleKey) ? "checked" : ""}><span>${escapeHtml(ROLE_CONFIG[roleKey].label)}</span></label>`).join("")}</div><small>Leadership positions are separate from the account role.</small></fieldset>`;
      const assignmentMarkup = member.active !== false && canManageMemberAssignments(member) ? `<form class="member-assignment-form" data-manage-member="${escapeAttr(member.uid)}">${member.role === "admin" ? `<label>Admin team assignment<select name="adminTeamAssignment">${adminTeamAssignmentOptions(member.adminTeamAssignment)}</select></label>` : `<label>Account role<select name="role">${roleOptions}</select></label>${dashboardAssignmentMarkup}${teamLeadAssignmentMarkup}`}<label>University<select name="universityTag">${universityOptionsMarkup(member.universityTag)}</select></label>${member.role === "admin" ? "" : `<label data-leading-university ${member.role === "leaders" ? "" : "hidden"}>Leads university<select name="leadingUniversityTag">${universityOptionsMarkup(member.leadingUniversityTag)}</select><small>If you leave this blank, their University field sets the task scope.</small></label>`}<button class="btn btn-outline btn-compact" type="submit">Save assignments</button></form>` : "";
      const accountActionButton = state.role === "admin" && member.role !== "admin" && member.uid !== state.user?.uid
        ? `<button class="btn ${member.active === false ? "btn-outline" : "btn-danger"} btn-compact" type="button" data-toggle-member-active="${escapeAttr(member.uid)}">${member.active === false ? "Reactivate account" : "Deactivate account"}</button>`
        : "";
      const accountStatus = member.active === false ? "Inactive" : "Active";
      return `<article class="team-member-row"><a class="team-member-identity" href="profile.html?uid=${encodeURIComponent(member.uid)}">${profileAvatarMarkup(member, "large")}<span><strong>${escapeHtml(memberDisplayName(member))}</strong><small>${escapeHtml(role)} · ${accountStatus}</small></span></a><div class="team-member-stats"><span><strong>${Number(member.xp) || 0}</strong>XP</span><span><strong>${level}</strong>Level</span><span><strong>${Number(member.answersCount) || 0}</strong>Answers</span><span><strong>${Number(member.tasksCompleted) || 0}</strong>Tasks done</span><span class="member-university-stat"><strong>${escapeHtml(member.universityTag || "—")}</strong>${escapeHtml(university?.name || "University")}</span></div><div class="member-admin-controls">${assignmentMarkup}${member.active === false ? "" : xpAdjustmentMarkup(member)}${accountActionButton}</div></article>`;
    }).join("")}</div></section>`).join("")
    : `<div class="empty-state">No team profiles found.</div>`;
  renderDashboardAccessTarget();
  refs.teamMembersList.querySelectorAll("form[data-manage-member]").forEach((form) => {
    const details = document.createElement("details");
    details.className = "member-assignment-details";
    const summary = document.createElement("summary");
    summary.textContent = "Edit assignments";
    form.replaceWith(details);
    details.append(summary, form);
  });
  refs.teamMembersList.querySelectorAll("[data-manage-member]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveMemberAssignments(form.dataset.manageMember, form);
  }));
  refs.teamMembersList.querySelectorAll('[data-manage-member] [name="role"]').forEach((select) => select.addEventListener("change", () => {
    const dashboardAccess = select.closest("form")?.querySelector("[data-dashboard-assignment]");
    if (dashboardAccess) dashboardAccess.hidden = select.value !== "user";
    const leadingUniversity = select.closest("form")?.querySelector("[data-leading-university]");
    if (leadingUniversity) leadingUniversity.hidden = select.value !== "leaders";
  }));
  refs.teamMembersList.querySelectorAll("[data-adjust-xp]").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    adjustXp(form.dataset.adjustXp, form.querySelector("[name=amount]")?.value, form.querySelector("[name=direction]")?.value, form.querySelector("[name=reason]")?.value);
  }));
  renderRatingsMatrix();
}

async function setTeamMemberActive(uid, button) {
  if (state.role !== "admin" || !uid || uid === state.user?.uid) {
    return showToast("Only an Admin can change another member's access.", "error");
  }
  const member = state.teamMembers.find((item) => item.uid === uid);
  if (!member || member.role === "admin") {
    return showToast("This account cannot be changed from the team dashboard.", "error");
  }
  const name = memberDisplayName(member);
  const nextActive = member.active === false;
  const action = nextActive ? "Reactivate" : "Deactivate";
  const explanation = nextActive
    ? `${name} will be able to sign in and use the site again.`
    : `${name} will lose access to the site, but their sign-in account and saved data will remain. You can reactivate them later.`;
  if (!window.confirm(`${action} ${name}'s account? ${explanation}`)) return;
  if (button) {
    button.disabled = true;
    button.textContent = nextActive ? "Reactivating…" : "Deactivating…";
  }
  try {
    const latest = await getDoc(doc(db, "teamMembers", uid));
    if (!latest.exists() || latest.data().role === "admin") {
      throw new Error("This member account is no longer available for this action.");
    }
    await updateDoc(doc(db, "teamMembers", uid), {
      active: nextActive,
      updatedAt: serverTimestamp()
    });
    state.teamMembers = state.teamMembers.map((item) => item.uid === uid
      ? { ...item, active: nextActive, updatedAt: new Date() }
      : item);
    state.leaderboardMembers = state.leaderboardMembers.map((item) => item.uid === uid
      ? { ...item, active: nextActive }
      : item);
    renderTeamMembers();
    renderLeaderboard();
    showToast(nextActive ? `${name}'s account has been reactivated.` : `${name}'s site access has been deactivated.`);
  } catch (error) {
    showToast(firebaseError(error), "error");
    try { await loadTeamMembers(); } catch (_) { /* Keep the original error visible. */ }
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = nextActive ? "Reactivate account" : "Deactivate account";
    }
  }
}

async function saveMemberAssignments(uid, form) {
  const member = state.teamMembers.find((item) => item.uid === uid);
  if (!member) return;
  if (!canManageMemberAssignments(member)) return showToast("Member assignment access is required. Admin accounts and your own role are protected.", "error");
  if (member.role === "admin") {
    const adminTeamAssignmentValue = form.querySelector("[name=adminTeamAssignment]")?.value || "";
    if (adminTeamAssignmentValue && !adminTeamAssignment({ role: "admin", adminTeamAssignment: adminTeamAssignmentValue })) {
      return showToast("Choose a valid team assignment.", "error");
    }
    try {
      if (String(member.adminTeamAssignment || "") === adminTeamAssignmentValue) {
        return showToast("No team assignment changes to save.", "info");
      }
      const batch = writeBatch(db);
      batch.update(doc(db, "teamMembers", uid), {
        adminTeamAssignment: adminTeamAssignmentValue,
        updatedAt: serverTimestamp()
      });
      batch.set(doc(collection(db, "teamMembers", uid, "notifications")), inboxNotificationData(
        "member_assignment", "Your team assignment was updated",
        adminTeamAssignmentValue
          ? `Your Admin account was assigned as ${adminTeamAssignmentValue.replace(":", " for the ")} team. Your Admin permissions are unchanged.`
          : "Your Admin account's team assignment was removed. Your Admin permissions are unchanged."
      ));
      await batch.commit();
      member.adminTeamAssignment = adminTeamAssignmentValue;
      if (uid === state.user?.uid) {
        state.member = { ...state.member, adminTeamAssignment: adminTeamAssignmentValue };
      }
      renderTeamMembers();
      showToast(adminTeamAssignmentValue
        ? "Admin team assignment saved."
        : "Admin removed from the team assignment.");
    } catch (error) {
      showToast(firebaseError(error), "error");
    }
    return;
  }
  const nextRole = member.role === "admin" ? "admin" : (form.querySelector("[name=role]")?.value || member.role);
  if (!ROLE_CONFIG[nextRole] || (member.role !== "admin" && nextRole === "admin")) return showToast("Choose a valid non-admin account role.", "error");
  const dashboardRoles = nextRole === "user"
    ? [...form.querySelectorAll('[name="dashboardRoles"]:checked')].map((input) => input.value)
    : [];
  const teamLeadRoles = member.role === "admin"
    ? (Array.isArray(member.teamLeadRoles) ? member.teamLeadRoles : [])
    : [...form.querySelectorAll('[name="teamLeadRoles"]:checked')].map((input) => input.value);
  if (nextRole === "user" && (!dashboardRoles.length || dashboardRoles.some((role) => !ASSIGNABLE_DASHBOARD_ROLES.includes(role)))) {
    return showToast("Choose at least one valid dashboard for this User account.", "error");
  }
  if (teamLeadRoles.some((role) => !ASSIGNABLE_DASHBOARD_ROLES.includes(role))) {
    return showToast("Choose only valid non-admin teams for team lead access.", "error");
  }
  const universityTag = form.querySelector("[name=universityTag]")?.value || "";
  const leadingUniversityTag = nextRole === "leaders"
    ? (form.querySelector("[name=leadingUniversityTag]")?.value || "")
    : "";
  if (universityTag && !universityByTag(universityTag)) return showToast("Choose a valid university.", "error");
  if (nextRole === "leaders" && leadingUniversityTag && !universityByTag(leadingUniversityTag)) return showToast("Choose a valid university for this leader.", "error");
  try {
    const memberRef = doc(db, "teamMembers", uid);
    const ratingsRef = doc(db, "memberRatings", uid);
    const inboxRef = doc(collection(db, "teamMembers", uid, "notifications"));
    await runTransaction(db, async (transaction) => {
      const [snapshot, ratingsSnapshot] = await Promise.all([
        transaction.get(memberRef), state.role === "admin" ? transaction.get(ratingsRef) : Promise.resolve(null)
      ]);
      if (!snapshot.exists()) throw new Error("This team member no longer exists.");
      const latest = snapshot.data();
      if (!canManageMemberAssignments({ uid, ...latest })) throw new Error("This account can no longer be managed with your permissions.");
      const latestDashboardRoles = Array.isArray(latest.dashboardRoles) ? latest.dashboardRoles : [];
      const latestTeamLeadRoles = Array.isArray(latest.teamLeadRoles) ? latest.teamLeadRoles : [];
      const assignmentsUnchanged = latest.role === nextRole
        && latest.universityTag === universityTag
        && (nextRole !== "leaders" || latest.leadingUniversityTag === leadingUniversityTag)
        && latestDashboardRoles.length === dashboardRoles.length
        && latestDashboardRoles.every((role) => dashboardRoles.includes(role))
        && latestTeamLeadRoles.length === teamLeadRoles.length
        && latestTeamLeadRoles.every((role) => teamLeadRoles.includes(role));
      if (assignmentsUnchanged) return;
      transaction.update(memberRef, {
        role: nextRole, dashboardRoles, teamLeadRoles, universityTag, leadingUniversityTag,
        updatedAt: serverTimestamp()
      });
      if (ratingsSnapshot?.exists() && latest.universityTag !== universityTag) {
        transaction.update(ratingsRef, {
          universityTag, active: latest.active === true,
          updatedByUid: state.user.uid, updatedAt: serverTimestamp()
        });
      }
      transaction.set(inboxRef, inboxNotificationData(
        "member_assignment",
        "Your team access was updated",
        `Your account role is now ${ROLE_CONFIG[nextRole].label}${nextRole === "user" ? ` with ${dashboardRoles.length} assigned dashboard${dashboardRoles.length === 1 ? "" : "s"}` : ""}${teamLeadRoles.length ? ` You are also a team lead for ${teamLeadRoles.map((role) => ROLE_CONFIG[role].label).join(", ")}.` : ""}`
      ));
    });
    member.role = nextRole;
    member.dashboardRoles = dashboardRoles;
    member.universityTag = universityTag;
    member.leadingUniversityTag = leadingUniversityTag;
    member.teamLeadRoles = teamLeadRoles;
    if (uid === state.user?.uid) {
      state.member = { ...state.member, role: nextRole, dashboardRoles, teamLeadRoles, universityTag, leadingUniversityTag };
    }
    renderTeamMembers();
    renderLeaderboard();
    if (uid === state.user?.uid) {
      state.member = { ...state.member, universityTag, leadingUniversityTag };
      await loadMemberChat();
    }
    showToast("University assignment saved.");
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function adjustXp(uid, rawAmount, direction, rawReason) {
  const amount = Number(rawAmount);
  const reason = String(rawReason || "").trim();
  const member = state.teamMembers.find((item) => item.uid === uid)
    || state.leaderboardMembers.find((item) => item.uid === uid);
  if (!canManageMember(member, "xpManage")) return showToast("XP management access is required.", "error");
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return showToast("Enter an XP amount from 1 to 100,000.", "error");
  if (!["add", "subtract"].includes(direction)) return showToast("Choose whether to add or subtract XP.", "error");
  if (reason.length < 3) return showToast("Enter a reason for this XP change.", "error");
  const memberRef = doc(db, "teamMembers", uid);
  const inboxRef = doc(collection(db, "teamMembers", uid, "notifications"));
  let nextXp = 0;
  let previousXp = 0;
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(memberRef);
      if (!snapshot.exists()) throw new Error("This team member no longer exists.");
      const latestMember = { uid, ...snapshot.data() };
      if (!canManageMember(latestMember, "xpManage")) throw new Error("XP management access is required.");
      previousXp = Math.max(0, Number(latestMember.xp) || 0);
      nextXp = direction === "add" ? previousXp + amount : Math.max(0, previousXp - amount);
      if (nextXp === previousXp) throw new Error("This member has no XP to subtract.");
      transaction.update(memberRef, {
        xp: nextXp, level: levelForXp(nextXp), updatedAt: serverTimestamp()
      });
      const applied = Math.abs(nextXp - previousXp);
      transaction.set(inboxRef, inboxNotificationData(
        "xp_adjustment",
        `XP ${direction === "add" ? "added" : "subtracted"}`,
        `${memberDisplayName(latestMember)}: ${previousXp} → ${nextXp} XP (${direction === "add" ? "+" : "−"}${applied}). Reason: ${reason}`
      ));
    });
    [...state.teamMembers, ...state.leaderboardMembers].filter((item) => item.uid === uid).forEach((item) => {
      item.xp = nextXp;
      item.level = levelForXp(nextXp);
    });
    renderTeamMembers();
    renderLeaderboard();
    showToast(`${Math.abs(nextXp - previousXp)} XP ${direction === "add" ? "added to" : "subtracted from"} ${memberDisplayName(member)}.`);
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

function renderRatingsMatrix() {
  if (!refs.ratingsMatrix) return;
  const roleLeadTargets = currentTeamLeadRoles();
  const isUniversityLeader = state.role === "leaders" && Boolean(universityByTag(state.member?.leadingUniversityTag));
  const selectedRoleLead = state.role !== "admin" && currentTeamLeadRoles().includes(state.activeDashboardRole)
    ? state.activeDashboardRole : "";
  const scopedMembers = canReadAllRatings()
    ? state.teamMembers
    : state.teamMembers.filter((member) => member.active !== false
      && member.uid !== state.user?.uid
      && ((selectedRoleLead ? member.role === selectedRoleLead : roleLeadTargets.includes(member.role))
        || (isUniversityLeader && member.universityTag === state.member?.leadingUniversityTag)));
  const adminActions = $("ratingAdminActions");
  adminActions?.classList.toggle("hidden", !hasDashboardAccess("xpReset") && !hasDashboardAccess("ratingsReset"));
  $("resetAllXpBtn")?.classList.toggle("hidden", !hasDashboardAccess("xpReset"));
  $("resetAllRatingsBtn")?.classList.toggle("hidden", !hasDashboardAccess("ratingsReset"));
  if (!canReadAllRatings() && state.role === "leaders" && !isUniversityLeader && !roleLeadTargets.length) {
    refs.ratingsMatrix.innerHTML = `<div class="empty-state">An admin must assign your university before you can review ratings.</div>`;
    return;
  }
  if (!scopedMembers.length) {
    state.selectedRatingUid = "";
    refs.ratingsMatrix.innerHTML = `<div class="empty-state">No members are available for this rating sheet.</div>`;
    return;
  }
  if (!scopedMembers.some((member) => member.uid === state.selectedRatingUid)) {
    state.selectedRatingUid = scopedMembers[0].uid;
  }
  const selectedMember = scopedMembers.find((member) => member.uid === state.selectedRatingUid);
  const memberButtons = scopedMembers.map((member) => {
    const selected = member.uid === selectedMember.uid;
    return `<button class="rating-member-button${selected ? " is-selected" : ""}" type="button" data-rating-member-select="${escapeAttr(member.uid)}" aria-pressed="${selected}" title="${escapeAttr(memberDisplayName(member))}">
      ${profileAvatarMarkup(member, "small")}
      <span class="rating-member-button-copy"><strong>${escapeHtml(memberDisplayName(member))}</strong><small>${escapeHtml(universityByTag(member.universityTag)?.name || member.universityTag || "—")}</small></span>
      <span class="rating-member-button-xp">${Number(member.xp) || 0} XP</span>
    </button>`;
  }).join("");
  const scores = selectedMember.ratingScores || {};
  const notes = selectedMember.ratingNotes || {};
  const categoryCards = RATING_CATEGORIES.map((category) => `<article class="rating-category-card">
    <div class="rating-category-heading"><label for="rating-score-${category.key}">${escapeHtml(category.label)}</label><span>0–100</span></div>
    <input id="rating-score-${category.key}" aria-label="${escapeAttr(category.label)} score for ${escapeAttr(memberDisplayName(selectedMember))}" class="rating-score-input" data-rating-score="${category.key}" type="number" min="0" max="100" step="1" value="${scores[category.key] ?? ""}" placeholder="—">
    <textarea aria-label="${escapeAttr(category.label)} note for ${escapeAttr(memberDisplayName(selectedMember))}" data-rating-note="${category.key}" rows="2" maxlength="500" placeholder="اكتب ملاحظة...">${escapeHtml(notes[category.key] || "")}</textarea>
  </article>`).join("");
  refs.ratingsMatrix.innerHTML = `<div class="ratings-workspace">
    <div class="rating-member-picker" role="group" aria-label="Choose a member to rate">${memberButtons}</div>
    <section class="rating-editor-pane" data-rating-member="${escapeAttr(selectedMember.uid)}" aria-label="Ratings for ${escapeAttr(memberDisplayName(selectedMember))}">
      <header class="rating-selected-member">
        ${profileAvatarMarkup(selectedMember, "small")}
        <div><strong>${escapeHtml(memberDisplayName(selectedMember))}</strong><small>${escapeHtml(universityByTag(selectedMember.universityTag)?.name || selectedMember.universityTag || "—")} · ${Number(selectedMember.xp) || 0} XP</small></div>
      </header>
      <div class="rating-category-grid">${categoryCards}</div>
      <div class="rating-save-row"><span>Enter a score and a short note for each category you rate.</span><button type="button" class="btn btn-primary btn-compact" data-save-rating="${escapeAttr(selectedMember.uid)}">Save ratings</button></div>
    </section>
  </div>`;
  if (!canManageMember(selectedMember, "ratingsManage")) {
    refs.ratingsMatrix.querySelectorAll("input,textarea").forEach((input) => { input.disabled = true; });
    refs.ratingsMatrix.querySelector(".rating-save-row")?.remove();
  }
  refs.ratingsMatrix.querySelectorAll("[data-rating-member-select]").forEach((button) => button.addEventListener("click", () => {
    state.selectedRatingUid = button.dataset.ratingMemberSelect;
    renderRatingsMatrix();
  }));
  refs.ratingsMatrix.querySelector("[data-save-rating]")?.addEventListener("click", (event) => {
    const editor = event.currentTarget.closest("[data-rating-member]");
    if (editor) saveMemberRatings(event.currentTarget.dataset.saveRating, editor);
  });
}

function renderMyRatings(rating = null) {
  if (!refs.myRatingsContent) return;
  const scores = rating?.scores || {};
  const notes = rating?.notes || {};
  const hasData = Object.keys(scores).length > 0 || Object.keys(notes).length > 0;
  refs.myRatingsContent.innerHTML = `<div class="my-rating-category-grid">${RATING_CATEGORIES.map((category) => `
    <article class="my-rating-category-card">
      <div class="my-rating-category-heading"><strong>${escapeHtml(category.label)}</strong><span>${Object.prototype.hasOwnProperty.call(scores, category.key) ? `${Number(scores[category.key])}/100` : "Not rated yet"}</span></div>
      <p>${escapeHtml(notes[category.key] || "No note has been added for this category.")}</p>
    </article>`).join("")}</div>${hasData ? "" : `<p class="panel-hint">Your rating sheet is ready. Scores and notes will appear here after a leader or admin updates them.</p>`}`;
  if (refs.myRatingsUpdated) refs.myRatingsUpdated.textContent = rating?.updatedAt
    ? `Last updated ${formatDate(rating.updatedAt)} · This is your personal rating view`
    : "This view shows your own scores and notes.";
}

async function loadMyRatings() {
  if (!state.user?.uid || !refs.myRatingsContent) return;
  refs.myRatingsContent.innerHTML = `<div class="empty-state">Loading your rating sheet…</div>`;
  try {
    const snapshot = await getDoc(doc(db, "memberRatings", state.user.uid));
    state.myRating = snapshot.exists() ? snapshot.data() : null;
    renderMyRatings(state.myRating);
  } catch (error) {
    refs.myRatingsContent.innerHTML = `<div class="empty-state">Your rating sheet could not be loaded. Check that the latest Firestore rules are deployed.</div>`;
    showToast(firebaseError(error), "error");
  }
}

async function saveMemberRatings(uid, row) {
  const member = state.teamMembers.find((item) => item.uid === uid);
  if (!member || !canManageMember(member, "ratingsManage")) return showToast("Rating management access is required.", "error");
  const scores = {};
  const notes = {};
  for (const category of RATING_CATEGORIES) {
    const rawScore = row.querySelector(`[data-rating-score="${category.key}"]`)?.value.trim() || "";
    const note = row.querySelector(`[data-rating-note="${category.key}"]`)?.value.trim() || "";
    if (rawScore !== "") {
      const score = Number(rawScore);
      if (!Number.isInteger(score) || score < 0 || score > 100) return showToast(`${category.label}: use a whole-number score from 0 to 100.`, "error");
      if (note.length < 2) return showToast(`Add a note for ${category.label} before saving its score.`, "error");
      scores[category.key] = score;
    }
    if (note) notes[category.key] = note;
  }
  const oldScores = member.ratingScores || {};
  const oldNotes = member.ratingNotes || {};
  const sameMap = (left, right) => RATING_CATEGORIES.every(({ key }) => (left[key] ?? null) === (right[key] ?? null));
  if (sameMap(oldScores, scores) && sameMap(oldNotes, notes)) return showToast("No rating changes to save.");
  const summary = RATING_CATEGORIES
    .filter(({ key }) => (scores[key] ?? null) !== (oldScores[key] ?? null) || (notes[key] ?? null) !== (oldNotes[key] ?? null))
    .map(({ key, label }) => `${label}: ${scores[key] ?? "—"}/100${notes[key] ? ` — ${notes[key]}` : ""}`)
    .join(" · ").slice(0, 1300);
  const memberRef = doc(db, "teamMembers", uid);
  const ratingsRef = doc(db, "memberRatings", uid);
  const inboxRef = doc(collection(db, "teamMembers", uid, "notifications"));
  try {
    await runTransaction(db, async (transaction) => {
      const [snapshot, ratingsSnapshot] = await Promise.all([
        transaction.get(memberRef), transaction.get(ratingsRef)
      ]);
      if (!snapshot.exists()) throw new Error("This team member no longer exists.");
      const latestMember = { uid, ...snapshot.data() };
      if (!canManageMember(latestMember, "ratingsManage")) throw new Error("Rating management access is required.");
      transaction.set(ratingsRef, {
        scores, notes, universityTag: latestMember.universityTag || "",
        active: latestMember.active === true,
        updatedByUid: state.user.uid, updatedAt: serverTimestamp()
      });
      transaction.set(inboxRef, inboxNotificationData(
        "ratings_update",
        "Your member ratings were updated",
        `Your ratings changed: ${summary}`
      ));
    });
    member.ratingScores = scores;
    member.ratingNotes = notes;
    renderRatingsMatrix();
    showToast(`Ratings saved for ${memberDisplayName(member)}.`);
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function resetAllMemberValues(kind) {
  if (!["xp", "ratings"].includes(kind)) return;
  if (!hasDashboardAccess(kind === "xp" ? "xpReset" : "ratingsReset")) return showToast("Bulk reset access is required.", "error");
  const scope = state.role === "admin" ? "every team member" : "all other non-admin members";
  const message = kind === "xp"
    ? `Reset XP to 0 for ${scope}? Each affected member will receive an inbox record.`
    : `Clear category scores and notes for ${scope}? Each affected member will receive an inbox record.`;
  if (!window.confirm(message)) return;
  const affected = state.teamMembers.filter((member) => state.role === "admin" || (member.role !== "admin" && member.uid !== state.user?.uid)).filter((member) => kind === "xp"
    ? Number(member.xp) !== 0 || Number(member.level) > 1
    : Object.keys(member.ratingScores || {}).length > 0 || Object.keys(member.ratingNotes || {}).length > 0);
  if (!affected.length) return showToast(kind === "xp" ? "All XP is already at 0." : "All ratings are already clear.");
  try {
    for (let offset = 0; offset < affected.length; offset += 5) {
      const batch = writeBatch(db);
      const members = affected.slice(offset, offset + 5);
      members.forEach((member) => {
        const ratingsRef = doc(db, "memberRatings", member.uid);
        const inboxRef = doc(collection(db, "teamMembers", member.uid, "notifications"));
        if (kind === "xp") {
          const memberRef = doc(db, "teamMembers", member.uid);
          batch.update(memberRef, { xp: 0, level: 1, updatedAt: serverTimestamp() });
          batch.set(inboxRef, inboxNotificationData(
            "xp_reset",
            "Team XP was reset",
            "A permitted manager reset your XP total to 0."
          ));
        } else {
          batch.set(ratingsRef, {
            scores: {}, notes: {}, universityTag: member.universityTag || "",
            active: member.active === true,
            updatedByUid: state.user.uid, updatedAt: serverTimestamp()
          });
          batch.set(inboxRef, inboxNotificationData(
            "ratings_reset",
            "Your ratings were reset",
            "A permitted manager cleared your category ratings and notes."
          ));
        }
      });
      await batch.commit();
    }
    await loadTeamMembers();
    await loadLeaderboard();
    showToast(`${kind === "xp" ? "XP" : "Ratings and notes"} reset for ${affected.length} member${affected.length === 1 ? "" : "s"}.`);
  } catch (error) {
    showToast(`Reset stopped before all batches finished: ${firebaseError(error)}`, "error");
    await loadTeamMembers();
    await loadLeaderboard();
  }
}

let directoryMembers = [];
let directoryReady = false;
let directoryLoading = false;

function selectedDirectoryRole() {
  const role = new URLSearchParams(window.location.search).get("role");
  return DIRECTORY_ROLE_ORDER.includes(role) ? role : "";
}

function renderTeamDirectory() {
  const root = $("teamDirectory");
  if (!root) return;
  const role = selectedDirectoryRole();
  if (!role) {
    root.innerHTML = `<div class="team-role-grid">${DIRECTORY_ROLE_ORDER.map(key => {
      const count = directoryMembers.filter(member => member.role === key).length;
      return `<a class="team-role-card" data-role-theme="${key}" href="about-team.html?role=${key}">${roleDecorationMarkup(key)}<h2>${escapeHtml(ROLE_CONFIG[key].label)}</h2><span>${directoryReady ? `${count} member${count === 1 ? "" : "s"}` : "Loading…"}</span><span class="team-card-arrow" aria-hidden="true">${materialIcon("arrow_forward")}</span></a>`;
    }).join("")}</div>`;
    return;
  }
  const members = directoryMembers.filter(member => member.role === role).sort((a,b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
  root.innerHTML = `<div data-role-theme="${role}" class="team-role-view"><a class="back-link" href="about-team.html">← All roles</a><div class="team-role-heading"><h2>${escapeHtml(ROLE_CONFIG[role].label)}</h2><span>${members.length} member${members.length === 1 ? "" : "s"}</span></div>${!directoryReady ? '<div class="empty-state">Loading members…</div>' : members.length ? `<div class="team-directory-members">${members.map(member => `<article class="team-directory-member"><a class="team-directory-profile" href="profile.html?uid=${encodeURIComponent(member.uid)}">${profileAvatarMarkup(member,"large")}<h3>${escapeHtml(memberDisplayName(member))}</h3><p>${escapeHtml(member.bio || "")}</p><span class="directory-link">View profile <b aria-hidden="true">→</b></span></a>${socialLinksMarkup(member.socialLinks)}</article>`).join("")}</div>` : '<div class="empty-state">No members in this role yet.</div>'}</div>`;
}

async function loadTeamDirectory() {
  if (directoryLoading) return;
  directoryLoading = true;
  renderTeamDirectory();
  try {
    const snapshot = await getDocs(query(collection(db,"teamMembers"), where("active","==",true)));
    directoryMembers = snapshot.docs.map(item => ({...item.data(), uid:item.id}));
    directoryReady = true;
    renderTeamDirectory();
  } catch (error) {
    const root = $("teamDirectory");
    if (root) root.innerHTML = '<div class="empty-state" role="alert">Team members could not be loaded.</div><button type="button" class="btn btn-outline" id="retryTeamDirectory">Retry</button>';
    $("retryTeamDirectory")?.addEventListener("click", loadTeamDirectory);
  } finally { directoryLoading = false; }
}

if (page === "team") {
  document.addEventListener("click", event => {
    const link = event.target.closest?.('a[href^="about-team.html"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", link.href);
    renderTeamDirectory();
  });
  window.addEventListener("popstate", renderTeamDirectory);
}

const PROFILE_ART_STICKERS = Object.freeze(["⭐", "✨", "💡", "📚", "🎨", "🌱", "🚀", "💜", "🌷", "🧡", "🏆", "🪄"]);
const PROFILE_ART_MAX_ITEMS = 12;
const PROFILE_STICKER_INVENTORY_MAX = 12;
const PROFILE_STICKER_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_STICKER_TYPES = Object.freeze(["image/png", "image/webp", "image/gif", "image/jpeg"]);

function sanitizePublicProfileArt(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, PROFILE_ART_MAX_ITEMS).map((item, index) => {
    const kind = ["sticker", "note", "badge", "uploadedSticker"].includes(item?.kind) ? item.kind : "";
    let text = String(item?.value || "").trim();
    if (kind === "sticker" && !PROFILE_ART_STICKERS.includes(text)) return null;
    if (kind === "note") text = text.slice(0, 80);
    if (kind === "badge") text = text.slice(0, 32);
    if (kind === "uploadedSticker") text = text.slice(0, 160);
    if (!kind || !text) return null;
    const stickerId = /^[a-zA-Z0-9_-]{10,200}$/.test(String(item?.stickerId || ""))
      ? String(item.stickerId)
      : "";
    if (kind === "uploadedSticker" && !stickerId) return null;
    const id = /^[a-zA-Z0-9_-]{1,40}$/.test(String(item?.id || ""))
      ? String(item.id)
      : `profile-art-${index}`;
    const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : 50;
    const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : 50;
    return {
      id, kind, value: text,
      ...(kind === "uploadedSticker" ? { stickerId } : {}),
      x: Math.max(0, Math.min(100, Math.round(x))),
      y: Math.max(0, Math.min(100, Math.round(y))),
      rotation: Math.max(-180, Math.min(180, Math.round(Number(item?.rotation) || 0))),
      scale: Math.max(50, Math.min(200, Math.round(Number(item?.scale) || 100)))
    };
  }).filter(Boolean);
}

function sanitizePublicProfileStickers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, PROFILE_STICKER_INVENTORY_MAX).filter((item) =>
    /^[a-zA-Z0-9_-]{10,200}$/.test(String(item?.id || ""))
    && PROFILE_STICKER_TYPES.includes(item?.mimeType)
    && String(item?.fileName || "").trim()
    && Number(item?.sizeBytes) > 0
    && Number(item?.sizeBytes) <= PROFILE_STICKER_MAX_BYTES
  ).map((item) => ({
    id: String(item.id),
    fileName: String(item.fileName).trim().slice(0, 160),
    mimeType: item.mimeType,
    sizeBytes: Math.round(Number(item.sizeBytes)),
    uploadedAt: String(item.uploadedAt || "").slice(0, 40)
  }));
}

function profileStickerInventoryMarkup(inventory, profileUid, previews = new Map()) {
  if (!inventory.length) return `<p class="profile-sticker-empty">Your Drive stickers will stay here for your next edit.</p>`;
  return inventory.map((sticker) => {
    const previewUrl = previews.get(sticker.id) || "";
    return `<article class="profile-sticker-inventory-item">
    <img ${previewUrl ? `src="${escapeAttr(previewUrl)}"` : `data-sticker-preview="${escapeAttr(sticker.id)}"`} alt="" loading="lazy">
    <span title="${escapeAttr(sticker.fileName)}">${escapeHtml(sticker.fileName)}</span>
    <button type="button" class="btn btn-outline btn-compact" draggable="true" data-add-uploaded-sticker="${escapeAttr(sticker.id)}" title="Drag this sticker onto your profile">Place</button>
    <button type="button" class="btn btn-danger btn-compact" data-remove-uploaded-sticker="${escapeAttr(sticker.id)}" aria-label="Delete ${escapeAttr(sticker.fileName)} from your sticker inventory">Delete</button>
  </article>`;
  }).join("");
}

function profileArtItemMarkup(item, editable, profileUid = "", previews = new Map()) {
  const position = `left:${item.x}%;top:${item.y}%;--art-rotation:${item.rotation}deg;--art-scale:${(Number(item.scale) || 100) / 100}`;
  const content = item.kind === "uploadedSticker"
    ? `<img class="profile-art-uploaded-image" src="${escapeAttr(previews.get(item.stickerId) || driveProfileStickerUrl(item.stickerId, profileUid))}" alt="${escapeAttr(item.value)}" loading="lazy">`
    : item.kind === "sticker"
    ? `<span class="profile-art-sticker" aria-hidden="true">${escapeHtml(item.value)}</span>`
    : `<span class="profile-art-copy">${escapeHtml(item.value)}</span>`;
  if (!editable) return `<div class="profile-art-item profile-art-${item.kind}" style="${position}">${content}</div>`;
  const label = item.kind === "sticker" ? `Move sticker ${item.value}` : item.kind === "uploadedSticker" ? `Move uploaded sticker ${item.value}` : `Move ${item.kind} ${item.value}`;
  return `<div class="profile-art-item profile-art-${item.kind}" data-profile-art-item="${escapeAttr(item.id)}" style="${position}">
    <button type="button" class="profile-art-handle" data-profile-art-handle="${escapeAttr(item.id)}" aria-label="${escapeAttr(label)}">${content}</button>
    <button type="button" class="profile-art-remove" data-profile-art-remove="${escapeAttr(item.id)}" aria-label="Remove ${escapeAttr(item.kind)}">×</button>
  </div>`;
}

function profileArtBoardMarkup(items, editable, inventory = [], profileUid = "", profileCard = "") {
  const tools = editable ? `<div class="profile-art-tools" data-profile-art-tools>
    <div class="profile-art-tool-group"><strong>Stickers</strong><p>Drag a sticker directly onto any part of your public profile. You can also click to add it, then move it.</p><div class="profile-art-sticker-picker">${PROFILE_ART_STICKERS.map((sticker) => `<button type="button" draggable="true" class="profile-art-sticker-option" data-add-profile-sticker="${escapeAttr(sticker)}" aria-label="Drag or add ${escapeAttr(sticker)}">${escapeHtml(sticker)}</button>`).join("")}</div></div>
    <div class="profile-sticker-upload"><div class="profile-art-tool-group"><strong>Upload your own sticker</strong><p>PNG, WebP, GIF, or JPEG · up to 5 MB. Uploaded images stay private in Drive and remain in your inventory.</p><div class="profile-sticker-upload-row"><label class="profile-sticker-file-label">Choose image<input type="file" data-profile-sticker-file accept="image/png,image/webp,image/gif,image/jpeg"></label><button type="button" class="btn btn-outline btn-compact" data-upload-profile-sticker>Upload to Drive</button></div><progress data-profile-sticker-progress max="100" value="0" hidden></progress></div><div class="profile-sticker-inventory-heading"><strong>Your sticker inventory</strong><span>${inventory.length}/${PROFILE_STICKER_INVENTORY_MAX}</span></div><div class="profile-sticker-inventory" data-profile-sticker-inventory>${profileStickerInventoryMarkup(inventory, profileUid)}</div></div>
    <div class="profile-art-inspector" data-profile-art-inspector hidden><div><strong data-profile-art-selected-label>Sticker selected</strong><small>Adjust its size and angle on your profile.</small></div><label>Size <output data-profile-art-scale-output>100%</output><input type="range" data-profile-art-scale min="50" max="200" step="5" value="100"></label><label>Rotation <output data-profile-art-rotation-output>0°</output><input type="range" data-profile-art-rotation min="-180" max="180" step="5" value="0"></label><button type="button" class="btn btn-danger btn-compact" data-remove-selected-profile-art>Remove from page</button></div>
    <form class="profile-art-text-form" data-profile-art-text-form><label>Add a note or badge<input name="value" type="text" maxlength="80" placeholder="A short phrase for your page" required></label><label>Style<select name="kind"><option value="note">Note card</option><option value="badge">Badge</option></select></label><button class="btn btn-outline btn-compact" type="submit">Add to page</button></form>
    <div class="profile-art-save-row"><small id="profileArtSaveStatus" role="status" aria-live="polite">Drag any sticker onto the profile above. Select a sticker to change its size or angle, or remove it.</small><div><button type="button" class="btn btn-outline btn-compact" data-clear-profile-art>Clear stickers</button><button type="button" class="btn btn-primary btn-compact" data-save-profile-art>Save profile &amp; stickers</button></div></div>
  </div>` : "";
  const composition = editable || items.length ? `<div class="profile-public-composition profile-artboard" data-profile-artboard aria-label="Public profile page">
    ${profileCard}
    <div class="profile-art-layer" data-profile-art-layer aria-label="Profile stickers">${items.map((item) => profileArtItemMarkup(item, editable, profileUid)).join("")}</div>
  </div>` : profileCard;
  return `${composition}
  ${editable ? `<section class="public-profile-studio" data-role-theme="${escapeAttr(document.body.dataset.profileRole || "public")}">
    <div class="public-profile-studio-heading"><div><span class="eyebrow">Your profile studio</span><h2>Make this page yours</h2><p>Place stickers directly on your profile, then drag them into position.</p></div><span class="profile-art-count">${items.length}/${PROFILE_ART_MAX_ITEMS}</span></div>${tools}
  </section>` : ""}
  ${editable || items.length ? `<p class="profile-mobile-sticker-note">${editable ? "Profile stickers and editing are available on desktop. Open this page on a computer to arrange and save them." : "Profile stickers are shown on desktop screens. Open this page on a computer to see them."}</p>` : ""}`;
}

function setupPublicProfileArt(root, profile) {
  const editor = root.querySelector("[data-profile-art-tools]");
  const board = root.querySelector("[data-profile-artboard]");
  const layer = root.querySelector("[data-profile-art-layer]");
  if (!editor || !board || !layer) return;
  let items = sanitizePublicProfileArt(profile.publicProfileArt);
  let inventory = sanitizePublicProfileStickers(profile.publicProfileStickers);
  const previewUrls = new Map();
  let dragging = null;
  let saving = false;
  let uploadingSticker = false;
  let deletingSticker = false;
  let selectedItemId = "";
  const inspector = editor.querySelector("[data-profile-art-inspector]");
  window.addEventListener("pagehide", () => {
    previewUrls.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
  }, { once: true });

  const setStatus = (message, error = false) => {
    const status = root.querySelector("#profileArtSaveStatus");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", error);
  };
  const markChanged = () => {
    setStatus("Unsaved changes. Save your design when it looks right.");
    const save = root.querySelector("[data-save-profile-art]");
    if (save) save.disabled = false;
  };
  const updateInspector = () => {
    const item = items.find((entry) => entry.id === selectedItemId);
    if (!inspector) return;
    inspector.hidden = !item;
    if (!item) return;
    const name = item.kind === "uploadedSticker" ? item.value
      : item.kind === "sticker" ? `Sticker ${item.value}`
        : `${item.kind === "badge" ? "Badge" : "Note"}: ${item.value}`;
    const label = inspector.querySelector("[data-profile-art-selected-label]");
    const scale = inspector.querySelector("[data-profile-art-scale]");
    const rotation = inspector.querySelector("[data-profile-art-rotation]");
    const scaleOutput = inspector.querySelector("[data-profile-art-scale-output]");
    const rotationOutput = inspector.querySelector("[data-profile-art-rotation-output]");
    if (label) label.textContent = name;
    if (scale) scale.value = String(item.scale || 100);
    if (rotation) rotation.value = String(item.rotation || 0);
    if (scaleOutput) scaleOutput.textContent = `${item.scale || 100}%`;
    if (rotationOutput) rotationOutput.textContent = `${item.rotation || 0}°`;
    layer.querySelectorAll("[data-profile-art-item]").forEach((element) => {
      element.classList.toggle("is-selected", element.dataset.profileArtItem === item.id);
    });
  };
  const render = () => {
    if (!items.some((item) => item.id === selectedItemId)) selectedItemId = "";
    layer.innerHTML = items.map((item) => profileArtItemMarkup(item, true, profile.uid, previewUrls)).join("");
    const count = root.querySelector(".profile-art-count");
    if (count) count.textContent = `${items.length}/${PROFILE_ART_MAX_ITEMS}`;
    updateInspector();
  };
  const renderInventory = () => {
    const inventoryRoot = editor.querySelector("[data-profile-sticker-inventory]");
    const count = editor.querySelector(".profile-sticker-inventory-heading span");
    if (inventoryRoot) inventoryRoot.innerHTML = profileStickerInventoryMarkup(inventory, profile.uid, previewUrls);
    if (count) count.textContent = `${inventory.length}/${PROFILE_STICKER_INVENTORY_MAX}`;
  };
  const loadInventoryPreviews = async () => {
    const pending = inventory.filter((sticker) => !previewUrls.has(sticker.id));
    const failures = [];
    await Promise.all(pending.map(async (sticker) => {
      try {
        const previewUrl = await requestDriveProfileStickerPreview(auth, sticker.id);
        previewUrls.set(sticker.id, previewUrl);
      } catch (error) {
        failures.push(error);
      }
    }));
    renderInventory();
    render();
    if (failures.length) {
      setStatus("Some private Drive stickers could not be previewed. Check that the updated Drive worker is deployed.", true);
    }
  };
  const makeId = () => window.crypto?.randomUUID?.()
    || `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const makeArtItem = (kind, value, placement = null, stickerId = "") => {
    const maxLength = kind === "sticker" ? 8 : kind === "note" ? 80 : kind === "badge" ? 32 : 160;
    const text = String(value || "").trim().slice(0, maxLength);
    if (!text || (kind === "sticker" && !PROFILE_ART_STICKERS.includes(text))) return null;
    const index = items.length;
    return {
      id: makeId(), kind, value: text,
      ...(kind === "uploadedSticker" ? { stickerId } : {}),
      x: placement ? Math.max(0, Math.min(100, Math.round(placement.x))) : 24 + (index % 4) * 17,
      y: placement ? Math.max(0, Math.min(100, Math.round(placement.y))) : 30 + (Math.floor(index / 4) % 3) * 18,
      rotation: index % 2 ? 4 : -4,
      scale: 100
    };
  };
  const selectItem = (id) => {
    selectedItemId = items.some((item) => item.id === id) ? id : "";
    updateInspector();
  };
  const add = (kind, value, placement = null, stickerId = "") => {
    if (items.length >= PROFILE_ART_MAX_ITEMS) return setStatus(`This page can hold up to ${PROFILE_ART_MAX_ITEMS} items.`, true);
    const item = makeArtItem(kind, value, placement, stickerId);
    if (!item) return;
    items.push(item);
    selectedItemId = item.id;
    render();
    markChanged();
    return item;
  };
  const addUploadedSticker = (sticker, placement = null) => {
    if (!sticker || items.length >= PROFILE_ART_MAX_ITEMS) return setStatus(`This page can hold up to ${PROFILE_ART_MAX_ITEMS} items. Your upload is still saved in inventory.`, true);
    return add("uploadedSticker", sticker.fileName, placement, sticker.id);
  };
  const moveItem = (item, x, y) => {
    item.x = Math.max(0, Math.min(100, Math.round(x)));
    item.y = Math.max(0, Math.min(100, Math.round(y)));
    const element = layer.querySelector(`[data-profile-art-item="${CSS.escape(item.id)}"]`);
    if (element) {
      element.style.left = `${item.x}%`;
      element.style.top = `${item.y}%`;
    }
  };
  const removePlacedItem = (id) => {
    items = items.filter((item) => item.id !== id);
    if (selectedItemId === id) selectedItemId = "";
    render();
    markChanged();
  };
  const removeUploadedSticker = async (id) => {
    if (deletingSticker) return;
    const sticker = inventory.find((item) => item.id === id);
    if (!sticker || !state.user?.uid || state.user.uid !== profile.uid) return;
    if (!window.confirm(`Delete “${sticker.fileName}” from your sticker inventory and public profile?`)) return;
    deletingSticker = true;
    const deleteButton = editor.querySelector(`[data-remove-uploaded-sticker="${CSS.escape(id)}"]`);
    if (deleteButton) deleteButton.disabled = true;
    const nextInventory = inventory.filter((item) => item.id !== id);
    const nextItems = items.filter((item) => item.stickerId !== id);
    try {
      await updateDoc(doc(db, "teamMembers", profile.uid), {
        publicProfileStickers: nextInventory,
        publicProfileArt: nextItems.map((item) => ({ ...item })),
        updatedAt: serverTimestamp()
      });
      inventory = nextInventory;
      items = nextItems;
      profile.publicProfileStickers = nextInventory;
      profile.publicProfileArt = nextItems.map((item) => ({ ...item }));
      if (selectedItemId && !items.some((item) => item.id === selectedItemId)) selectedItemId = "";
      const previewUrl = previewUrls.get(id);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrls.delete(id);
      render();
      renderInventory();
      let driveError = null;
      try { await retireDriveProfileSticker(auth, id); }
      catch (error) { driveError = error; }
      setStatus(driveError
        ? "Sticker removed from your profile and inventory. Its private Drive copy could not be deleted."
        : "Sticker removed from your profile, inventory, and Drive.");
      showToast(driveError
        ? `Sticker removed from your profile and inventory, but its private Drive copy remains: ${firebaseError(driveError)}`
        : "Sticker deleted from your profile, inventory, and Drive.", driveError ? "error" : "ok");
    } catch (error) {
      const message = uploadedFileId && isProfilePermissionDenied(error)
        ? "The sticker reached Google Drive, but Firestore denied saving it to your profile. Publish the updated firestore.rules to the Firebase project used by this site, then try again."
        : profileWriteError(error, "your profile sticker");
      setStatus(message, true);
      showToast(message, "error");
    } finally {
      deletingSticker = false;
      renderInventory();
    }
  };
  render();
  renderInventory();
  void loadInventoryPreviews();

  editor.addEventListener("click", (event) => {
    const sticker = event.target.closest("[data-add-profile-sticker]");
    if (sticker) return add("sticker", sticker.dataset.addProfileSticker);
    const uploadedSticker = event.target.closest("[data-add-uploaded-sticker]");
    if (uploadedSticker) {
      const savedSticker = inventory.find((item) => item.id === uploadedSticker.dataset.addUploadedSticker);
      if (savedSticker) addUploadedSticker(savedSticker);
      return;
    }
    const removeFromInventory = event.target.closest("[data-remove-uploaded-sticker]");
    if (removeFromInventory) {
      void removeUploadedSticker(removeFromInventory.dataset.removeUploadedSticker);
      return;
    }
    if (event.target.closest("[data-remove-selected-profile-art]")) {
      if (selectedItemId) removePlacedItem(selectedItemId);
      return;
    }
    if (event.target.closest("[data-clear-profile-art]")) {
      items = [];
      selectedItemId = "";
      render();
      markChanged();
    }
  });
  editor.addEventListener("dragstart", (event) => {
    const sticker = event.target.closest("[data-add-profile-sticker]");
    const uploaded = event.target.closest("[data-add-uploaded-sticker]");
    let payload = null;
    if (sticker) payload = { kind: "sticker", value: sticker.dataset.addProfileSticker };
    if (uploaded) {
      const savedSticker = inventory.find((item) => item.id === uploaded.dataset.addUploadedSticker);
      if (savedSticker) payload = { kind: "uploadedSticker", stickerId: savedSticker.id };
    }
    if (!payload || !event.dataTransfer) return;
    event.dataTransfer.setData("application/x-nawras-profile-art", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  });
  editor.addEventListener("input", (event) => {
    const item = items.find((entry) => entry.id === selectedItemId);
    if (!item) return;
    const scaleInput = event.target.closest("[data-profile-art-scale]");
    const rotationInput = event.target.closest("[data-profile-art-rotation]");
    if (!scaleInput && !rotationInput) return;
    if (scaleInput) item.scale = Math.max(50, Math.min(200, Math.round(Number(scaleInput.value) || 100)));
    if (rotationInput) item.rotation = Math.max(-180, Math.min(180, Math.round(Number(rotationInput.value) || 0)));
    const element = layer.querySelector(`[data-profile-art-item="${CSS.escape(item.id)}"]`);
    if (element) {
      element.style.setProperty("--art-scale", String(item.scale / 100));
      element.style.setProperty("--art-rotation", `${item.rotation}deg`);
    }
    const scaleOutput = inspector?.querySelector("[data-profile-art-scale-output]");
    const rotationOutput = inspector?.querySelector("[data-profile-art-rotation-output]");
    if (scaleOutput) scaleOutput.textContent = `${item.scale}%`;
    if (rotationOutput) rotationOutput.textContent = `${item.rotation}°`;
    markChanged();
  });
  editor.querySelector("[data-profile-art-text-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.querySelector('[name="value"]');
    const kind = form.querySelector('[name="kind"]')?.value === "badge" ? "badge" : "note";
    const value = input?.value.trim() || "";
    if (!value) return;
    add(kind, value);
    form.reset();
  });
  editor.querySelector("[data-upload-profile-sticker]")?.addEventListener("click", async (event) => {
    if (uploadingSticker) return;
    if (!state.user?.uid || state.user.uid !== profile.uid) return showToast("Sign in to upload stickers to your own profile.", "error");
    if (inventory.length >= PROFILE_STICKER_INVENTORY_MAX) return showToast(`Your inventory can hold up to ${PROFILE_STICKER_INVENTORY_MAX} stickers.`, "error");
    if (items.length >= PROFILE_ART_MAX_ITEMS) return showToast("Remove a placed item before uploading another sticker to the profile.", "error");
    const input = editor.querySelector("[data-profile-sticker-file]");
    const file = input?.files?.[0];
    if (!file) return showToast("Choose a sticker image from your device first.", "error");
    if (!PROFILE_STICKER_TYPES.includes(file.type)) return showToast("Use a PNG, WebP, GIF, or JPEG image.", "error");
    if (file.size > PROFILE_STICKER_MAX_BYTES) return showToast("Profile stickers must be 5 MB or smaller.", "error");
    if (!isDriveStorageConfigured()) return showToast("Google Drive uploads are not connected yet.", "error");
    uploadingSticker = true;
    const button = event.currentTarget;
    const progress = editor.querySelector("[data-profile-sticker-progress]");
    button.disabled = true;
    button.textContent = "Uploading…";
    if (progress) { progress.hidden = false; progress.value = 0; }
    let uploadedFileId = "";
    let stagedPreviewUrl = "";
    try {
      const uploaded = await uploadDriveFile(auth, file, {
        category: "profileSticker",
        sourceId: profile.uid,
        sizeBytes: file.size
      }, {
        onProgress: (percent) => { if (progress) progress.value = percent; }
      });
      if (!uploaded?.id) throw new Error("Google Drive did not return a sticker file ID.");
      uploadedFileId = uploaded.id;
      const newSticker = {
        id: uploaded.id,
        fileName: String(uploaded.fileName || file.name).slice(0, 160),
        mimeType: PROFILE_STICKER_TYPES.includes(uploaded.mimeType) ? uploaded.mimeType : file.type,
        sizeBytes: Math.max(1, Math.min(PROFILE_STICKER_MAX_BYTES, Number(uploaded.sizeBytes) || file.size)),
        uploadedAt: String(uploaded.uploadedAt || new Date().toISOString()).slice(0, 40)
      };
      const nextInventory = [...inventory, newSticker];
      const newArtItem = makeArtItem("uploadedSticker", newSticker.fileName, null, newSticker.id);
      if (!newArtItem) throw new Error("The sticker could not be added to your profile.");
      const nextArt = [...items, newArtItem];
      try {
        stagedPreviewUrl = URL.createObjectURL(file);
        previewUrls.set(newSticker.id, stagedPreviewUrl);
      } catch (_) { stagedPreviewUrl = ""; }
      await updateDoc(doc(db, "teamMembers", profile.uid), {
        publicProfileStickers: nextInventory,
        publicProfileArt: nextArt,
        updatedAt: serverTimestamp()
      });
      inventory = nextInventory;
      items = nextArt;
      selectedItemId = newArtItem.id;
      profile.publicProfileStickers = nextInventory;
      profile.publicProfileArt = nextArt.map((item) => ({ ...item }));
      render();
      renderInventory();
      input.value = "";
      setStatus("Sticker uploaded, placed, and saved to your public profile.");
      showToast("Sticker uploaded and saved to your public profile.");
    } catch (error) {
      if (uploadedFileId && !inventory.some((item) => item.id === uploadedFileId)) {
        try { await retireDriveProfileSticker(auth, uploadedFileId); } catch (_) { /* Keep the upload error as the useful message. */ }
        const previewUrl = previewUrls.get(uploadedFileId) || stagedPreviewUrl;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrls.delete(uploadedFileId);
      }
      const message = firebaseError(error);
      setStatus(message, true);
      showToast(message, "error");
    } finally {
      uploadingSticker = false;
      button.disabled = false;
      button.textContent = "Upload to Drive";
      if (progress) progress.hidden = true;
    }
  });
  board.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-profile-art-handle]");
    if (!handle || event.button !== 0) return;
    const item = items.find((entry) => entry.id === handle.dataset.profileArtHandle);
    if (!item) return;
    event.preventDefault();
    selectItem(item.id);
    const bounds = board.getBoundingClientRect();
    dragging = { id: item.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: item.x, y: item.y, bounds };
    handle.setPointerCapture?.(event.pointerId);
    board.classList.add("is-dragging");
  });
  board.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const item = items.find((entry) => entry.id === dragging.id);
    if (!item || !dragging.bounds.width || !dragging.bounds.height) return;
    const nextX = dragging.x + (event.clientX - dragging.startX) / dragging.bounds.width * 100;
    const nextY = dragging.y + (event.clientY - dragging.startY) / dragging.bounds.height * 100;
    moveItem(item, nextX, nextY);
  });
  const endDrag = (event) => {
    if (!dragging || (event?.pointerId !== undefined && event.pointerId !== dragging.pointerId)) return;
    dragging = null;
    board.classList.remove("is-dragging");
    markChanged();
  };
  board.addEventListener("pointerup", endDrag);
  board.addEventListener("pointercancel", endDrag);
  board.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-profile-art-remove]");
    if (remove) {
      removePlacedItem(remove.dataset.profileArtRemove);
      return;
    }
    const handle = event.target.closest("[data-profile-art-handle]");
    if (handle) selectItem(handle.dataset.profileArtHandle);
  });
  board.addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("application/x-nawras-profile-art")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    board.classList.add("is-drop-target");
  });
  board.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && board.contains(event.relatedTarget)) return;
    board.classList.remove("is-drop-target");
  });
  board.addEventListener("drop", (event) => {
    board.classList.remove("is-drop-target");
    const raw = event.dataTransfer?.getData("application/x-nawras-profile-art") || "";
    if (!raw) return;
    event.preventDefault();
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { return; }
    const bounds = board.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const placement = {
      x: (event.clientX - bounds.left) / bounds.width * 100,
      y: (event.clientY - bounds.top) / bounds.height * 100
    };
    if (payload.kind === "sticker" && PROFILE_ART_STICKERS.includes(payload.value)) {
      add("sticker", payload.value, placement);
    } else if (payload.kind === "uploadedSticker") {
      const sticker = inventory.find((item) => item.id === payload.stickerId);
      if (sticker) addUploadedSticker(sticker, placement);
    }
  });
  board.addEventListener("keydown", (event) => {
    const handle = event.target.closest("[data-profile-art-handle]");
    if (!handle) return;
    const item = items.find((entry) => entry.id === handle.dataset.profileArtHandle);
    if (!item) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removePlacedItem(item.id);
      return;
    }
    const step = event.shiftKey ? 8 : 3;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[event.key]) return;
    event.preventDefault();
    moveItem(item, item.x + moves[event.key][0], item.y + moves[event.key][1]);
    markChanged();
  });
  editor.querySelector("[data-save-profile-art]")?.addEventListener("click", async (event) => {
    if (saving) return;
    if (!state.user?.uid || state.user.uid !== profile.uid) return showToast("Sign in to edit your own public profile.", "error");
    saving = true;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await updateDoc(doc(db, "teamMembers", profile.uid), {
        publicProfileArt: items.map((item) => ({ ...item })),
        updatedAt: serverTimestamp()
      });
      profile.publicProfileArt = items.map((item) => ({ ...item }));
      setStatus("Your public profile design is saved.");
      showToast("Your public profile design is saved.");
    } catch (error) {
      const message = profileWriteError(error, "your profile design");
      setStatus(message, true);
      showToast(message, "error");
    } finally {
      saving = false;
      button.disabled = false;
      button.textContent = "Save profile & stickers";
    }
  });
}

async function loadProfilePage(uid) {
  const root = $("profilePage");
  if (!root || !uid) return;
  try {
    const snapshot = await getDoc(doc(db, "teamMembers", uid));
    if (!snapshot.exists() || snapshot.data().active === false) throw new Error("This profile is not available.");
    const profile = { uid, ...snapshot.data() };
    const themeRole = ROLE_ART[profile.role] ? profile.role : "public";
    document.body.dataset.profileRole = themeRole;
    const name = memberDisplayName(profile);
    const level = levelForXp(profile.xp);
    const editable = Boolean(state.user && !state.user.isAnonymous && state.user.uid === uid);
    const art = sanitizePublicProfileArt(profile.publicProfileArt);
    const stickerInventory = sanitizePublicProfileStickers(profile.publicProfileStickers);
    const profileCard = `<div class="profile-public-card" data-role-theme="${themeRole}">${profileAvatarMarkup(profile, "hero")}<div class="profile-public-copy"><span class="eyebrow">${escapeHtml(ROLE_CONFIG[profile.role]?.label || "NAWRAS team")}</span><h1>${escapeHtml(name)}</h1><p>${escapeHtml(profile.bio || "A NAWRAS EDU team member helping the community learn and grow.")}</p><div class="profile-university-tag">${escapeHtml(universityLabel(profile.universityTag))}</div><div class="profile-stat-row"><span><strong>${level}</strong>Level</span><span><strong>${Number(profile.xp) || 0}</strong>XP</span><span><strong>${Number(profile.answersCount) || 0}</strong>Answers</span><span><strong>${Number(profile.tasksCompleted) || 0}</strong>Tasks done</span></div></div></div>`;
    root.innerHTML = profileArtBoardMarkup(art, editable, stickerInventory, profile.uid, profileCard);
    root.querySelector(".profile-public-copy")?.insertAdjacentHTML("beforeend", socialLinksMarkup(profile.socialLinks));
    document.body.dataset.profileRole = themeRole;
    decorateRoleSurface(root.querySelector(".profile-public-card"), themeRole);
    if (editable) setupPublicProfileArt(root, profile);
  } catch (error) {
    document.body.removeAttribute("data-profile-role");
    root.innerHTML = `<div class="empty-state">${escapeHtml(error?.message || "This profile could not be loaded.")}</div>`;
  }
}

async function saveCourse(event) {
  event.preventDefault();
  if (!canManageCourses()) return showToast("You do not have permission to manage courses.", "error");
  const title = $("courseTitle").value.trim();
  const description = $("courseDescription").value.trim();
  const category = $("courseCategory").value.trim();
  const price = $("coursePrice").value.trim();
  const whatsappInput = $("courseWhatsapp").value.trim();
  const whatsappPhone = whatsappInput.replace(/\D/g, "");
  const ctaText = $("courseCtaText").value.trim();
  const ctaUrlInput = $("courseCtaUrl").value.trim();
  const ctaUrl = normalizeHttpUrl(ctaUrlInput);
  const imageUrl = extractImageUrl($("courseImageInput").value.trim());
  const published = $("coursePublished").checked;
  let assets = readCourseAssets();
  if (!assets) return;
  if (!title || !description) return showToast("Course title and description are required.", "error");
  if (Boolean(ctaText) !== Boolean(ctaUrlInput)) return showToast("Enter both the custom button text and its URL, or leave both blank.", "error");
  if (ctaUrlInput && !ctaUrl) return showToast("Use a valid http:// or https:// URL for the custom button.", "error");
  if (whatsappInput && (whatsappPhone.length < 7 || whatsappPhone.length > 15)) return showToast("Enter a valid WhatsApp number with country code (7–15 digits).", "error");
  const id = $("courseId").value;
  const existingCourse = id ? state.courses.find((course) => course.id === id) : null;
  const currentAssignments = state.courseAssignments.filter((assignment) => assignment.courseId === id);
  const currentMemberUids = currentAssignments.map((assignment) => assignment.memberUid);
  const assignedMemberUids = canManageCourses()
    ? selectedCourseAssignees()
    : (Array.isArray(existingCourse?.assignedMemberUids) ? existingCourse.assignedMemberUids : currentMemberUids);
  if (assignedMemberUids.length > 100) return showToast("Assign a course to no more than 100 members.", "error");
  try {
    const courseRef = id ? doc(db, "courses", id) : doc(collection(db, "courses"));
    const courseId = courseRef.id;
    assets = await uploadPendingCourseAssets(assets, courseId);
    const courseSettings = {
      title,
      description,
      category,
      imageUrl,
      price,
      whatsappPhone,
      ctaText,
      ctaUrl,
      published,
      publicVisible: published
    };
    const batch = writeBatch(db);
    if (id) {
      batch.update(courseRef, { ...courseSettings, updatedAt: serverTimestamp() });
    } else {
      batch.set(courseRef, { ...courseSettings, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.user.uid });
    }
    batch.set(doc(db, "coursePrivate", courseId), { assets });
    if (canManageCourses()) {
      const previous = new Set(currentMemberUids);
      const selected = new Set(assignedMemberUids);
      for (const memberUid of selected) {
        batch.set(doc(db, "courseAssignments", courseAssignmentDocId(courseId, memberUid)), {
          courseId,
          memberUid,
          assignedAt: serverTimestamp()
        });
      }
      for (const memberUid of previous) {
        if (!selected.has(memberUid)) {
          batch.delete(doc(db, "courseAssignments", courseAssignmentDocId(courseId, memberUid)));
        }
      }
    }
    await batch.commit();
    let notificationError = null;
    if (canManageCourses()) {
      const previousSet = new Set(currentMemberUids);
      const nextSet = new Set(assignedMemberUids);
      const addedUids = [...nextSet].filter((memberUid) => !previousSet.has(memberUid));
      const removedUids = [...previousSet].filter((memberUid) => !nextSet.has(memberUid));
      const unchangedUids = id ? [...nextSet].filter((memberUid) => previousSet.has(memberUid)) : [];
      const targets = [
        ...addedUids.map((uid) => ({
          uid, title: `Course assigned: ${title}`,
          message: `A course has been assigned to you: ${title}. Open My courses in your dashboard to view its sessions and materials.`
        })),
        ...removedUids.map((uid) => ({
          uid, title: `Course access updated: ${title}`,
          message: `Your assignment for ${title} was removed. Contact an admin if you think this was a mistake.`
        })),
        ...unchangedUids.map((uid) => ({
          uid, title: `Course updated: ${title}`,
          message: `${title} was updated. Open My courses in your dashboard to see the latest details and materials.`
        }))
      ];
      try {
        for (const target of targets) {
          const member = state.teamMembers.find((item) => item.uid === target.uid && item.active === true);
          if (member) {
            await notifyInboxMembers([member], "course_update", target.title, target.message, { courseId });
          }
        }
      } catch (error) { notificationError = error; }
    }
    closeModal("courseModal");
    resetCourseForm();
    showToast(notificationError
      ? `Course saved, but some inbox notices could not be sent: ${firebaseError(notificationError)}`
      : id ? "Course updated and assigned members were notified."
        : "Course added and newly assigned members were notified.",
      notificationError ? "error" : "ok");
    await loadTeamData();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function uploadPendingCourseAssets(assets, courseId) {
  const result = [];
  for (const asset of assets) {
    if (!asset.file) {
      const { row, file, ...savedAsset } = asset;
      result.push(savedAsset);
      continue;
    }
    const progress = asset.row?.querySelector("[data-course-asset-progress]");
    if (progress) { progress.hidden = false; progress.value = 0; }
    const uploaded = await uploadDriveFile(auth, asset.file, {
      category: "courseAsset",
      sourceId: courseId,
      sizeBytes: asset.file.size
    }, {
      onProgress: (percent) => { if (progress) progress.value = percent; }
    });
    result.push({
      title: asset.title,
      kind: asset.kind,
      url: "",
      driveFileId: uploaded.id,
      driveFileName: uploaded.fileName,
      driveMimeType: uploaded.mimeType,
      driveSizeBytes: uploaded.sizeBytes,
      driveUploadedByUid: state.user.uid,
      driveUploadedAt: uploaded.uploadedAt || new Date().toISOString()
    });
  }
  return result;
}

function formAudienceType(form) {
  return ["public", "role", "university", "leader_university"].includes(form?.audienceType)
    ? form.audienceType
    : "public";
}

function formAudienceSummary(form) {
  const audience = formAudienceType(form);
  if (audience === "role") return form.targetRole === "all" ? "all team roles" : ROLE_CONFIG[form.targetRole]?.label || "selected team";
  if (audience === "university") return form.targetUniversityTag === "all" ? "members at all universities" : `members at ${form.targetUniversityTag || "the selected university"}`;
  if (audience === "leader_university") return form.targetUniversityTag === "all" ? "leaders across all universities" : `leaders for ${form.targetUniversityTag || "the selected university"}`;
  return "Public";
}

function syncFormAudienceFields() {
  const audience = $("managedFormAudience")?.value || "public";
  const roleWrap = $("managedFormRoleWrap");
  const universityWrap = $("managedFormUniversityWrap");
  roleWrap?.classList.toggle("hidden", audience !== "role");
  universityWrap?.classList.toggle("hidden", !["university", "leader_university"].includes(audience));
}

function formMatchesMember(form, member) {
  const audience = formAudienceType(form);
  if (audience === "public") return true;
  if (!member || member.active === false) return false;
  if (audience === "role") return form.targetRole === "all"
    ? Boolean(ROLE_CONFIG[member.role])
    : Boolean(form.targetRole) && member.role === form.targetRole;
  if (audience === "university") return form.targetUniversityTag === "all"
    ? Boolean(universityByTag(member.universityTag))
    : Boolean(form.targetUniversityTag) && member.universityTag === form.targetUniversityTag;
  if (audience === "leader_university") {
    return member.role === "leaders"
      && (form.targetUniversityTag === "all"
        ? Boolean(universityByTag(member.leadingUniversityTag))
        : Boolean(form.targetUniversityTag) && member.leadingUniversityTag === form.targetUniversityTag);
  }
  return false;
}

function canCurrentMemberViewForm(form) {
  return formAudienceType(form) === "public"
    || (state.isTeam && (canManageForms() || hasDashboardAccess("formsRead") || formMatchesMember(form, state.member)));
}

function formAudienceChanged(previous, next) {
  if (!next.published || formAudienceType(next) === "public") return false;
  if (!previous || previous.published === false) return true;
  return formAudienceType(previous) !== formAudienceType(next)
    || String(previous.targetRole || "") !== String(next.targetRole || "")
    || String(previous.targetUniversityTag || "") !== String(next.targetUniversityTag || "")
    || ["title", "description", "language", "imageUrl", "ctaText", "ctaUrl", "fields"]
      .some((key) => JSON.stringify(previous[key] ?? "") !== JSON.stringify(next[key] ?? ""));
}

async function notifyFormAudience(form, updated = false) {
  const audience = formAudienceType(form);
  if (!form?.id || !form.published || audience === "public") return 0;
  const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
  const recipients = snapshot.docs
    .map((item) => ({ uid: item.id, ...item.data() }))
    .filter((member) => formMatchesMember(form, member));
  // Each recipient notification is checked against that member’s profile in
  // Firestore rules, so keep atomic batches below the rules access-call limit.
  for (let offset = 0; offset < recipients.length; offset += 5) {
    const batch = writeBatch(db);
    recipients.slice(offset, offset + 5).forEach((member) => {
      const notificationRef = doc(collection(db, "teamMembers", member.uid, "notifications"));
      batch.set(notificationRef, inboxNotificationData(
        "form_available",
        `${updated ? "Form updated" : "New form"}: ${String(form.title || "NAWRAS form").slice(0, 100)}`,
        `A form for ${formAudienceSummary(form)} ${updated ? "was updated" : "is ready"}. Sign in with the matching team account to view it.`,
        { formId: form.id }
      ));
    });
    await batch.commit();
  }
  return recipients.length;
}

async function migrateLegacyFormAudiences(forms) {
  const legacyForms = forms.filter((form) => !Object.prototype.hasOwnProperty.call(form, "audienceType"));
  for (let offset = 0; offset < legacyForms.length; offset += 450) {
    const batch = writeBatch(db);
    legacyForms.slice(offset, offset + 450).forEach((form) => {
      batch.update(doc(db, "forms", form.id), {
        audienceType: "public",
        targetRole: "",
        targetUniversityTag: ""
      });
    });
    await batch.commit();
  }
}

async function saveManagedForm(event) {
  event.preventDefault();
  if (!canManageForms()) return showToast("You do not have permission to manage forms.", "error");
  const title = $("managedFormTitle").value.trim();
  const description = $("managedFormDescription").value.trim();
  const language = $("managedFormLanguage").value === "en" ? "en" : "ar";
  const imageUrl = extractImageUrl($("managedFormImageInput").value.trim());
  const ctaText = $("managedFormCtaText").value.trim();
  const ctaUrlInput = $("managedFormCtaUrl").value.trim();
  const ctaUrl = normalizeHttpUrl(ctaUrlInput);
  const published = $("managedFormPublished").checked;
  const audienceType = $("managedFormAudience")?.value || "public";
  const targetRole = audienceType === "role" ? $("managedFormTargetRole")?.value || "" : "";
  const targetUniversityTag = ["university", "leader_university"].includes(audienceType)
    ? $("managedFormTargetUniversity")?.value || ""
    : "";
  const fields = state.fieldBuilder.map(normalizeField);
  if (!title) return showToast("Form title is required.", "error");
  if (Boolean(ctaText) !== Boolean(ctaUrlInput)) return showToast("Enter both the custom button text and its URL, or leave both blank.", "error");
  if (ctaUrlInput && !ctaUrl) return showToast("Use a valid http:// or https:// URL for the custom button.", "error");
  if (!["public", "role", "university", "leader_university"].includes(audienceType)) return showToast("Choose a valid form audience.", "error");
  if (audienceType === "role" && targetRole !== "all" && !ROLE_CONFIG[targetRole]) return showToast("Choose the team role that should receive this form.", "error");
  if (["university", "leader_university"].includes(audienceType)
    && targetUniversityTag !== "all"
    && !universityByTag(targetUniversityTag)) return showToast("Choose the university tag that should receive this form.", "error");
  if (!fields.length) return showToast("Add at least one question.", "error");
  if (fields.some((field) => !field.label)) return showToast("Every question needs a label.", "error");
  if (fields.some((field) => ["select", "radio", "multiselect"].includes(field.type) && !field.options.length)) {
    return showToast("Dropdown, single-choice, and multiple-choice questions need at least one option.", "error");
  }
  const formSettings = { title, description, language, imageUrl, ctaText, ctaUrl, published, fields, audienceType, targetRole, targetUniversityTag };
  const id = $("managedFormId").value;
  const previous = id ? state.forms.find((item) => item.id === id) || null : null;
  try {
    let savedId = id;
    if (id) {
      await updateDoc(doc(db, "forms", id), { ...formSettings, updatedAt: serverTimestamp() });
    } else {
      const created = await addDoc(collection(db, "forms"), { ...formSettings, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: state.user.uid });
      savedId = created.id;
    }
    let notificationError = null;
    if (formAudienceChanged(previous, formSettings)) {
      try {
        const count = await notifyFormAudience({ ...formSettings, id: savedId }, Boolean(previous && previous.published !== false));
        if (!count) notificationError = new Error("No active members currently match this audience.");
      } catch (error) {
        notificationError = error;
      }
    }
    closeModal("formModal");
    resetFormEditor();
    showToast(notificationError
      ? `Form saved, but its inbox notification was not delivered: ${firebaseError(notificationError)}`
      : id ? "Form updated." : "Form added.", notificationError ? "error" : "ok");
    if (canManageContent()) await loadTeamData();
    else await loadManagedForms();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function saveSchedule(event) {
  event.preventDefault();
  if (!canManageContent()) return showToast("Only technical users and admins can edit the schedule.", "error");
  const id = $("scheduleId").value.trim();
  const name = $("scheduleName").value.trim();
  const tag = $("scheduleTag").value.trim();
  const dayOfWeek = Number($("scheduleDayOfWeek").value);
  const start = $("scheduleStart").value;
  const end = $("scheduleEnd").value;
  const miroUrl = normalizeMiroUrl($("scheduleMiroUrl").value.trim());
  const attendUrl = normalizeHttpUrl($("scheduleAttendUrl").value.trim());
  const miroTitle = $("scheduleMiroTitle").value.trim();
  const description = $("scheduleDescription").value.trim();
  if (!name || !tag || ![4, 5, 6].includes(dayOfWeek) || !start || !end) return showToast("Name, day, start time, and end time are required.", "error");
  if (start >= end) return showToast("End time must be later than start time.", "error");
  if ($("scheduleMiroUrl").value.trim() && !miroUrl) return showToast("Use a valid https://miro.com board URL.", "error");
  if ($("scheduleAttendUrl").value.trim() && !attendUrl) return showToast("Use a valid http or https attendance link.", "error");
  const payload = { name, tag, dayOfWeek, start, end, miroUrl, attendUrl, miroTitle, description, updatedAt: serverTimestamp(), updatedBy: state.user.uid };
  try {
    if (id && state.schedule.find((item) => item.id === id)?.persisted !== false) await updateDoc(doc(db, "schedule", id), payload);
    else if (id) await setDoc(doc(db, "schedule", id), { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    else await addDoc(collection(db, "schedule"), { ...payload, createdAt: serverTimestamp(), createdBy: state.user.uid });
    closeModal("scheduleModal");
    resetScheduleForm();
    showToast(id ? "Training session updated." : "Training session added.");
    await loadSchedule();
    renderTeamSchedule();
    loadAssignedCourses();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

function newField() {
  return { id: crypto.randomUUID ? crypto.randomUUID() : `field_${Date.now()}_${Math.random().toString(16).slice(2)}`, label: "", type: "text", required: false, options: [] };
}

function normalizeField(field) {
  return {
    id: field.id, label: String(field.label || "").trim(), type: field.type,
    required: Boolean(field.required),
    options: Array.isArray(field.options) ? field.options.map((value) => String(value).trim()).filter(Boolean) : []
  };
}

function renderFieldBuilder() {
  const root = $("fieldBuilderList");
  if (!root) return;
  if (!state.fieldBuilder.length) {
    root.innerHTML = `<div class="empty-state">No questions yet. Add your first question.</div>`;
    return;
  }
  root.innerHTML = state.fieldBuilder.map((field, index) => `
    <div class="field-builder" data-field-index="${index}">
      <div class="field-builder-top">
        <label>Question <input data-key="label" dir="auto" value="${escapeAttr(field.label)}" placeholder="مثال: الاسم الكامل"></label>
        <label>Type <select data-key="type">${["text", "textarea", "email", "number", "date", "select", "radio", "multiselect", "checkbox", "rating"].map((type) => `<option value="${type}" ${field.type === type ? "selected" : ""}>${humanFieldType(type)}</option>`).join("")}</select></label>
        <button type="button" class="btn btn-outline field-remove">Remove</button>
      </div>
      <label class="check-row"><input data-key="required" type="checkbox" ${field.required ? "checked" : ""}><span>Required</span></label>
      <div class="field-extra ${["select", "radio", "multiselect"].includes(field.type) ? "" : "hidden"}">
        <label>Options (one per line)<textarea data-key="options" dir="auto" rows="3" placeholder="الخيار الأول&#10;الخيار الثاني&#10;الخيار الثالث">${escapeHtml((field.options || []).join("\n"))}</textarea></label>
      </div>
      <div class="field-order-tools"><button type="button" class="field-drag-handle" draggable="true" aria-label="Drag to reorder question ${index + 1}" title="Drag to reorder">⠿ <span>Drag</span></button><div><button type="button" class="btn btn-outline btn-compact field-move-up" aria-label="Move question up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-outline btn-compact field-move-down" aria-label="Move question down" ${index === state.fieldBuilder.length - 1 ? "disabled" : ""}>↓</button></div></div>
    </div>`).join("");

  let draggedIndex = null;
  root.querySelectorAll(".field-drag-handle").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      draggedIndex = Number(handle.closest("[data-field-index]").dataset.fieldIndex);
      event.dataTransfer?.setData("text/plain", String(draggedIndex));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      handle.closest(".field-builder")?.classList.add("is-dragging");
    });
    handle.addEventListener("dragend", () => {
      draggedIndex = null;
      root.querySelectorAll(".field-builder").forEach((item) => item.classList.remove("is-dragging", "is-drop-target"));
    });
  });
  root.querySelectorAll(".field-builder").forEach((item) => {
    item.addEventListener("dragover", (event) => {
      if (draggedIndex === null) return;
      event.preventDefault();
      item.classList.add("is-drop-target");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    item.addEventListener("dragleave", (event) => {
      if (!item.contains(event.relatedTarget)) item.classList.remove("is-drop-target");
    });
    item.addEventListener("drop", (event) => {
      if (draggedIndex === null) return;
      event.preventDefault();
      const targetIndex = Number(item.dataset.fieldIndex);
      const insertIndex = targetIndex - (draggedIndex < targetIndex ? 1 : 0);
      const [moved] = state.fieldBuilder.splice(draggedIndex, 1);
      state.fieldBuilder.splice(insertIndex, 0, moved);
      draggedIndex = null;
      renderFieldBuilder();
    });
  });
  root.querySelectorAll("[data-field-index]").forEach((item) => {
    const index = Number(item.dataset.fieldIndex);
    item.querySelectorAll("[data-key]").forEach((input) => input.addEventListener("input", () => {
      const key = input.dataset.key;
      if (key === "required") state.fieldBuilder[index].required = input.checked;
      else if (key === "options") state.fieldBuilder[index].options = input.value.split("\n").map((value) => value.trim()).filter(Boolean);
      else state.fieldBuilder[index][key] = input.value;
      if (key === "type") renderFieldBuilder();
    }));
    item.querySelector(".field-remove").addEventListener("click", () => {
      state.fieldBuilder.splice(index, 1);
      renderFieldBuilder();
    });
    item.querySelector(".field-move-up")?.addEventListener("click", () => moveBuilderField(index, -1));
    item.querySelector(".field-move-down")?.addEventListener("click", () => moveBuilderField(index, 1));
  });
}

function moveBuilderField(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= state.fieldBuilder.length) return;
  [state.fieldBuilder[index], state.fieldBuilder[target]] = [state.fieldBuilder[target], state.fieldBuilder[index]];
  renderFieldBuilder();
}

function openCourseEditor(course = null) {
  if (!canManageCourses()) return showToast("You do not have permission to manage courses.", "error");
  resetCourseForm();
  let assignedMemberUids = [];
  if (course) {
    $("courseModalTitle").textContent = "Edit course";
    $("courseId").value = course.id;
    $("courseTitle").value = course.title || "";
    $("courseDescription").value = course.description || "";
    $("courseCategory").value = course.category || "";
    $("coursePrice").value = course.price || "";
    $("courseWhatsapp").value = course.whatsappPhone || "";
    $("courseCtaText").value = course.ctaText || "";
    $("courseCtaUrl").value = course.ctaUrl || "";
    $("courseImageInput").value = course.imageUrl || "";
    $("coursePublished").checked = course.published !== false;
    assignedMemberUids = Array.isArray(course.assignedMemberUids) ? course.assignedMemberUids : [];
  }
  renderCourseAssetRows(course?.assets || []);
  renderCourseAssignees(assignedMemberUids);
  $("courseAssignmentField")?.classList.toggle("hidden", !canManageCourses());
  openModal("courseModal");
}

function resetCourseForm() {
  if (!$("courseForm")) return;
  $("courseModalTitle").textContent = "Add course";
  $("courseForm").reset();
  $("courseId").value = "";
  $("coursePublished").checked = true;
  renderCourseAssetRows([]);
  renderCourseAssignees([]);
  $("courseAssignmentField")?.classList.toggle("hidden", !canManageCourses());
}

function courseAssetRowMarkup(asset = {}) {
  const kinds = [
    ["video", "Video lesson"],
    ["session", "Session"],
    ["book", "Book / reading"],
    ["material", "Material"],
    ["link", "Other link"]
  ];
  const selectedKind = kinds.some(([kind]) => kind === asset.kind) ? asset.kind : "video";
  return `<div class="course-asset-row" data-course-asset-row
    data-drive-file-id="${escapeAttr(asset.driveFileId || "")}"
    data-drive-file-name="${escapeAttr(asset.driveFileName || "")}"
    data-drive-mime-type="${escapeAttr(asset.driveMimeType || "")}"
    data-drive-size-bytes="${escapeAttr(asset.driveSizeBytes || "")}"
    data-drive-uploaded-by-uid="${escapeAttr(asset.driveUploadedByUid || "")}"
    data-drive-uploaded-at="${escapeAttr(asset.driveUploadedAt || "")}">
    <div class="course-asset-fields">
      <label>Lesson or material title<input type="text" data-course-asset-title maxlength="100" value="${escapeAttr(asset.title || "")}" placeholder="Session 1 — Introduction" required></label>
      <label>Type<select data-course-asset-kind>${kinds.map(([kind, label]) => `<option value="${kind}" ${kind === selectedKind ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="course-asset-url">Resource URL<input type="url" data-course-asset-url maxlength="1500" value="${escapeAttr(asset.url || "")}" placeholder="Paste a public link, or upload a private Drive file"></label>
      <label class="course-asset-file">Upload a private file<input type="file" data-course-asset-file accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"><small data-course-asset-existing>${escapeHtml(asset.driveFileName ? `Current Drive file: ${asset.driveFileName}` : "Upload replaces the link above for this lesson.")}</small></label>
      <progress class="drive-upload-progress" data-course-asset-progress max="100" value="0" hidden></progress>
      <button class="btn btn-danger btn-compact" type="button" data-remove-course-asset>Remove</button>
    </div>
  </div>`;
}

function renderCourseAssetRows(assets = []) {
  const root = $("courseAssetRows");
  if (!root) return;
  const cleanAssets = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset === "object") : [];
  root.innerHTML = cleanAssets.map(courseAssetRowMarkup).join("");
  if (!cleanAssets.length) renderCourseAssetEmptyState();
}

function renderCourseAssetEmptyState() {
  const root = $("courseAssetRows");
  if (root && !root.querySelector("[data-course-asset-row]")) {
    root.innerHTML = `<p class="course-assets-empty" data-course-assets-empty>No lessons or materials added yet.</p>`;
  }
}

function addCourseAssetRow() {
  const root = $("courseAssetRows");
  if (!root) return;
  if (root.querySelectorAll("[data-course-asset-row]").length >= 24) {
    return showToast("A course can have up to 24 lessons or materials.", "error");
  }
  root.querySelector("[data-course-assets-empty]")?.remove();
  root.insertAdjacentHTML("beforeend", courseAssetRowMarkup());
}

function readCourseAssets() {
  const rows = Array.from($("courseAssetRows")?.querySelectorAll("[data-course-asset-row]") || []);
  if (rows.length > 24) {
    showToast("A course can have up to 24 lessons or materials.", "error");
    return null;
  }
  const assets = [];
  for (const row of rows) {
    const title = row.querySelector("[data-course-asset-title]")?.value.trim() || "";
    const kind = row.querySelector("[data-course-asset-kind]")?.value || "video";
    const url = normalizeHttpUrl(row.querySelector("[data-course-asset-url]")?.value.trim() || "");
    const file = row.querySelector("[data-course-asset-file]")?.files?.[0] || null;
    const driveFileId = row.dataset.driveFileId || "";
    if (!title || (!url && !file && !driveFileId)) {
      showToast("Each lesson or material needs a title and either a link or an uploaded file.", "error");
      return null;
    }
    assets.push({
      title, kind, url: file ? "" : url,
      driveFileId: file ? "" : driveFileId,
      driveFileName: file ? "" : row.dataset.driveFileName || "",
      driveMimeType: file ? "" : row.dataset.driveMimeType || "",
      driveSizeBytes: file ? 0 : Number(row.dataset.driveSizeBytes) || 0,
      driveUploadedByUid: file ? "" : row.dataset.driveUploadedByUid || "",
      driveUploadedAt: file ? "" : row.dataset.driveUploadedAt || "",
      file, row
    });
  }
  return assets;
}

function renderCourseAssignees(selectedUids = []) {
  const root = $("courseAssignees");
  if (!root) return;
  const selected = new Set(selectedUids);
  const members = state.teamMembers
    .filter((member) => member.active !== false)
    .sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b)));
  const searchText = String($("courseAssigneeSearch")?.value || "").trim().toLowerCase();
  const memberMatchesSearch = (member) => {
    const searchableText = [
      memberDisplayName(member),
      ROLE_CONFIG[member.role]?.label,
      member.role,
      member.universityTag,
      member.email,
      member.uid
    ].filter(Boolean).join(" ").toLowerCase();
    return !searchText || searchableText.includes(searchText);
  };
  const anyMatch = members.some(memberMatchesSearch);
  root.innerHTML = members.length
    ? `${members.map((member) => `<label class="check-row course-assignee-option" ${memberMatchesSearch(member) ? "" : "hidden"}><input type="checkbox" data-course-assignee value="${escapeAttr(member.uid)}" ${selected.has(member.uid) ? "checked" : ""}><span>${escapeHtml(memberDisplayName(member))}<small>${escapeHtml(ROLE_CONFIG[member.role]?.label || member.role || "Member")}${member.universityTag ? ` · ${escapeHtml(universityLabel(member.universityTag))}` : ""}</small></span></label>`).join("")}${anyMatch ? "" : `<p class="course-assignees-empty">No members match “${escapeHtml(searchText)}”.</p>`}`
    : `<p class="course-assignees-empty">No active team accounts are available.</p>`;
}

function selectedCourseAssignees() {
  return Array.from($("courseAssignees")?.querySelectorAll("[data-course-assignee]:checked") || [])
    .map((input) => input.value)
    .filter(Boolean);
}

function openFormEditor(form = null) {
  if (!canManageForms()) return showToast("You do not have permission to manage forms.", "error");
  resetFormEditor();
  if (form) {
    $("formModalTitle").textContent = "Edit form";
    $("managedFormId").value = form.id;
    $("managedFormTitle").value = form.title || "";
    $("managedFormDescription").value = form.description || "";
    $("managedFormLanguage").value = form.language === "en" ? "en" : "ar";
    $("managedFormCtaText").value = form.ctaText || "";
    $("managedFormCtaUrl").value = form.ctaUrl || "";
    $("managedFormImageInput").value = form.imageUrl || "";
    $("managedFormPublished").checked = form.published !== false;
    $("managedFormAudience").value = formAudienceType(form);
    $("managedFormTargetRole").value = form.targetRole || "";
    $("managedFormTargetUniversity").value = form.targetUniversityTag || "";
    syncFormAudienceFields();
    state.fieldBuilder = (form.fields || []).map((field) => ({ ...newField(), ...field }));
    renderFieldBuilder();
  }
  openModal("formModal");
}

function resetFormEditor() {
  if (!$("formBuilder")) return;
  $("formModalTitle").textContent = "Add form";
  $("formBuilder").reset();
  $("managedFormId").value = "";
  $("managedFormLanguage").value = "ar";
  $("managedFormPublished").checked = true;
  $("managedFormAudience").value = "public";
  $("managedFormTargetRole").value = "";
  $("managedFormTargetUniversity").value = "";
  syncFormAudienceFields();
  state.fieldBuilder = [newField()];
  renderFieldBuilder();
}

async function loadPublicCourses() {
  if (!refs.publicCoursesGrid) return;
  try {
    const snapshot = await getDocs(query(collection(db, "courses"), where("publicVisible", "==", true), orderBy("createdAt", "desc")));
    state.courses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  } catch (_) {
    try {
      const snapshot = await getDocs(query(collection(db, "courses"), where("publicVisible", "==", true)));
      state.courses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedDesc);
    } catch (error) {
      state.courses = [];
      showToast("Courses could not be loaded. Check your Firebase Firestore setup.", "error");
    }
  }
  populateCategories(state.courses);
  filterAndRenderCourses();
}

function courseAssignmentDocId(courseId, memberUid) {
  return `${courseId}_${memberUid}`;
}

function loadAssignedCourses() {
  if (!state.isTeam || !state.user || !refs.assignedCoursesList) return;
  if (state.assignedCoursesUnsubscribe) state.assignedCoursesUnsubscribe();
  refs.assignedCoursesList.innerHTML = `<div class="empty-state">Loading your assigned courses…</div>`;
  const memberUid = state.user.uid;
  let latestSnapshotVersion = 0;
  try {
    const assignedCoursesQuery = query(collection(db, "courseAssignments"), where("memberUid", "==", memberUid));
    state.assignedCoursesUnsubscribe = onSnapshot(assignedCoursesQuery, (snapshot) => {
      const version = ++latestSnapshotVersion;
      const courseIds = snapshot.docs
        .map((item) => item.data().courseId)
        .filter((courseId) => typeof courseId === "string" && courseId);
      Promise.all(courseIds.map(async (courseId) => {
        const [courseSnapshot, privateSnapshot] = await Promise.all([
          getDoc(doc(db, "courses", courseId)),
          getDoc(doc(db, "coursePrivate", courseId))
        ]);
        if (!courseSnapshot.exists()) return null;
        return {
          id: courseSnapshot.id,
          ...courseSnapshot.data(),
          assets: privateSnapshot.exists() && Array.isArray(privateSnapshot.data().assets)
            ? privateSnapshot.data().assets
            : []
        };
      })).then((courses) => {
        if (state.user?.uid !== memberUid || version !== latestSnapshotVersion) return;
        state.assignedCourses = courses.filter(Boolean)
          .sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
        renderAssignedCourses();
      }).catch((error) => {
        if (state.user?.uid !== memberUid || version !== latestSnapshotVersion) return;
        state.assignedCourses = [];
        refs.assignedCoursesList.innerHTML = `<div class="empty-state">Your assigned courses could not be loaded. ${escapeHtml(firebaseError(error))}</div>`;
      });
    }, (error) => {
      state.assignedCourses = [];
      refs.assignedCoursesList.innerHTML = `<div class="empty-state">Your assigned courses could not be loaded. ${escapeHtml(firebaseError(error))}</div>`;
    });
  } catch (error) {
    state.assignedCourses = [];
    refs.assignedCoursesList.innerHTML = `<div class="empty-state">Your assigned courses could not be loaded. ${escapeHtml(firebaseError(error))}</div>`;
  }
}

function renderAssignedCourses() {
  personalPlanner?.refreshOverview();
  if (!refs.assignedCoursesList) return;
  refs.assignedCoursesList.innerHTML = state.assignedCourses.length
    ? state.assignedCourses.map((course) => {
      const assetCount = Array.isArray(course.assets) ? course.assets.length : 0;
      return `<article class="assigned-course-card"><div class="assigned-course-copy">${course.category ? `<span class="card-tag">${escapeHtml(course.category)}</span>` : ""}<h3>${escapeHtml(course.title || "Course")}</h3><p>${escapeHtml(course.description || "")}</p><small>${assetCount} lesson${assetCount === 1 ? "" : "s"} &amp; materials</small></div><button class="btn btn-primary btn-compact" type="button" data-open-assigned-course="${escapeAttr(course.id)}">Open course <span aria-hidden="true">→</span></button></article>`;
    }).join("")
    : `<div class="empty-state">No courses have been assigned to you yet.</div>`;
  refs.assignedCoursesList.querySelectorAll("[data-open-assigned-course]").forEach((button) => {
    button.addEventListener("click", () => openCourseDetails(button.dataset.openAssignedCourse));
  });
}

function populateCategories(courses) {
  if (!refs.courseCategoryFilter) return;
  const categories = Array.from(new Set(courses.map((course) => course.category).filter(Boolean))).sort();
  refs.courseCategoryFilter.innerHTML = `<option value="all">All categories</option>${categories.map((category) => `<option value="${escapeAttr(category)}">${escapeHtml(category)}</option>`).join("")}`;
}

function filterAndRenderCourses() {
  if (!refs.publicCoursesGrid) return;
  let filtered = state.courses;
  if (state.searchQuery) filtered = filtered.filter((course) => `${course.title || ""} ${course.description || ""}`.toLowerCase().includes(state.searchQuery));
  if (state.selectedCategory !== "all") filtered = filtered.filter((course) => course.category === state.selectedCategory);
  renderPublicCourses(filtered);
}

async function loadPublicForms() {
  if (!refs.publicFormsGrid) return;
  try {
    const snapshot = await getDocs(query(
      collection(db, "forms"),
      where("published", "==", true),
      where("audienceType", "==", "public"),
      orderBy("createdAt", "desc")
    ));
    state.forms = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  } catch (_) {
    try {
      const snapshot = await getDocs(query(
        collection(db, "forms"),
        where("published", "==", true),
        where("audienceType", "==", "public")
      ));
      state.forms = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedDesc);
    } catch (error) {
      state.forms = [];
      showToast("Forms could not be loaded. Check your Firebase Firestore setup.", "error");
    }
  }
  renderPublicForms(state.forms);
  const sharedFormId = new URLSearchParams(window.location.search).get("form");
  if (page === "forms" && sharedFormId) await openPublicForm(sharedFormId);
}

async function loadMemberForms() {
  if (!state.isTeam || page !== "admin" || !refs.memberFormsList) return;
  const filters = [];
  if (state.role) {
    filters.push(["role", "targetRole", state.role]);
    filters.push(["role", "targetRole", "all"]);
  }
  if (state.member?.universityTag) filters.push(["university", "targetUniversityTag", state.member.universityTag]);
  if (universityByTag(state.member?.universityTag)) filters.push(["university", "targetUniversityTag", "all"]);
  if (state.role === "leaders" && universityByTag(state.member?.leadingUniversityTag)) {
    filters.push(["leader_university", "targetUniversityTag", state.member.leadingUniversityTag]);
  }
  if (state.role === "leaders" && state.member?.role === "leaders") {
    filters.push(["leader_university", "targetUniversityTag", "all"]);
  }
  if (!filters.length) {
    state.memberForms = [];
    renderMemberForms([]);
    return;
  }
  const results = await Promise.allSettled(filters.map(([audienceType, targetField, target]) => {
    return getDocs(query(
      collection(db, "forms"),
      where("published", "==", true),
      where("audienceType", "==", audienceType),
      where(targetField, "==", target)
    ));
  }));
  const loaded = results.filter((result) => result.status === "fulfilled");
  if (!loaded.length && results.length) {
    state.memberForms = [];
    renderMemberForms([], true);
    return;
  }
  const byId = new Map();
  loaded.forEach((result) => result.value.docs.forEach((item) => {
    const form = { id: item.id, ...item.data() };
    if (form.published === true && formMatchesMember(form, state.member)) byId.set(form.id, form);
  }));
  state.memberForms = Array.from(byId.values()).sort(sortByCreatedDesc);
  renderMemberForms(state.memberForms);
}

async function loadManagedForms() {
  if (!state.isTeam || page !== "admin" || !canReadManagedForms() || !refs.teamFormsList) return;
  try {
    let snapshot;
    try {
      snapshot = await getDocs(query(collection(db, "forms"), orderBy("createdAt", "desc")));
    } catch (_) {
      snapshot = await getDocs(collection(db, "forms"));
    }
    let forms = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedDesc);
    if (canManageForms()) await migrateLegacyFormAudiences(forms);
    forms = forms.map((form) => ({
      ...form,
      audienceType: formAudienceType(form),
      targetRole: form.targetRole || "",
      targetUniversityTag: form.targetUniversityTag || ""
    }));
    state.forms = forms;
    setCount(refs.formCount, forms.length);
    setCount(refs.formCountLabel, forms.length);
    renderTeamForms(forms);
  } catch (error) {
    showToast(firebaseError(error), "error");
    if (refs.teamFormsList) refs.teamFormsList.innerHTML = `<div class="empty-state">Forms could not be loaded. Check that the latest Firestore rules are deployed.</div>`;
  }
}

async function loadTeamData() {
  if (!state.isTeam || (!canReadCourses() && !canReadManagedForms())) return;
  try {
    const loadCollection = async (name) => {
      try {
        return await getDocs(query(collection(db, name), orderBy("createdAt", "desc")));
      } catch (_) {
        return await getDocs(collection(db, name));
      }
    };
    const canLoadCourses = canReadCourses();
    const canLoadForms = canReadManagedForms();
    const [courseSnapshot, formSnapshot, privateCourseSnapshot, assignmentSnapshot] = await Promise.all([
      canLoadCourses ? loadCollection("courses") : Promise.resolve(null),
      canLoadForms ? loadCollection("forms") : Promise.resolve(null),
      canLoadCourses ? getDocs(collection(db, "coursePrivate")) : Promise.resolve(null),
      canManageCourses() ? getDocs(collection(db, "courseAssignments")) : Promise.resolve(null)
    ]);
    if (!canLoadCourses) {
      state.courses = [];
      state.courseAssignments = [];
      renderTeamCourses([]);
    }
    if (!canLoadForms) {
      state.forms = [];
      renderTeamForms([]);
    }
    if (canLoadCourses) {
    const rawCourses = courseSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedDesc);
    const privateByCourse = new Map(privateCourseSnapshot.docs.map((item) => [item.id, item.data()]));
    const assignmentsById = new Map((assignmentSnapshot?.docs || []).map((item) => [item.id, { id: item.id, ...item.data() }]));
    if (canManageCourses()) await migrateLegacyCourseData(rawCourses, privateByCourse, assignmentsById);
    state.courseAssignments = Array.from(assignmentsById.values());
    const teamCourses = rawCourses.map((course) => {
      const privateCourse = privateByCourse.get(course.id);
      const assignedMemberUids = state.courseAssignments
        .filter((assignment) => assignment.courseId === course.id)
        .map((assignment) => assignment.memberUid);
      const { assets: legacyAssets, assignedMemberUids: _legacyAssignments, ...publicCourse } = course;
      return {
        ...publicCourse,
        assets: Array.isArray(privateCourse?.assets) ? privateCourse.assets : sanitizeCourseAssets(legacyAssets || []),
        assignedMemberUids
      };
    });
    state.courses = teamCourses;
    setCount(refs.courseCount, teamCourses.length);
    setCount(refs.courseCountLabel, teamCourses.length);
    populateCategories(teamCourses.filter((course) => course.published !== false));
    if (refs.publicCoursesGrid) filterAndRenderCourses();
    renderTeamCourses(teamCourses);
    }
    if (canLoadForms) {
    let teamForms = formSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort(sortByCreatedDesc);
    if (canManageForms()) await migrateLegacyFormAudiences(teamForms);
    teamForms = teamForms.map((form) => ({
      ...form,
      audienceType: formAudienceType(form),
      targetRole: form.targetRole || "",
      targetUniversityTag: form.targetUniversityTag || ""
    }));
    state.forms = teamForms;
    setCount(refs.formCount, teamForms.length);
    setCount(refs.formCountLabel, teamForms.length);
    if (refs.publicFormsGrid) renderPublicForms(teamForms.filter((form) => form.published !== false && formAudienceType(form) === "public"));
    renderTeamForms(teamForms);
    }
    // Session dates now come directly from NawrasOnline into personal calendars.
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

function sanitizeCourseAssets(value) {
  const allowedKinds = new Set(["video", "session", "book", "material", "link"]);
  return (Array.isArray(value) ? value : []).slice(0, 24).map((asset) => {
    const title = String(asset?.title || "").trim().slice(0, 100);
    const url = normalizeHttpUrl(asset?.url || "");
    const kind = allowedKinds.has(asset?.kind) ? asset.kind : "material";
    return title && url ? { title, kind, url } : null;
  }).filter(Boolean);
}

async function migrateLegacyCourseData(courses, privateByCourse, assignmentsById) {
  for (const course of courses) {
    const hasLegacyAssets = Object.prototype.hasOwnProperty.call(course, "assets");
    const hasLegacyAssignments = Object.prototype.hasOwnProperty.call(course, "assignedMemberUids");
    const needsMigration = hasLegacyAssets || hasLegacyAssignments || typeof course.publicVisible !== "boolean";
    if (!needsMigration) continue;

    const courseId = course.id;
    const batch = writeBatch(db);
    const updates = {
      published: course.published === true,
      publicVisible: course.published === true,
      updatedAt: serverTimestamp()
    };
    if (hasLegacyAssets) {
      updates.assets = deleteField();
      const currentPrivateData = privateByCourse.get(courseId);
      if (!Array.isArray(currentPrivateData?.assets)) {
        const assets = sanitizeCourseAssets(course.assets);
        batch.set(doc(db, "coursePrivate", courseId), { assets });
        privateByCourse.set(courseId, { assets });
      }
    }
    if (hasLegacyAssignments) {
      updates.assignedMemberUids = deleteField();
      const memberUids = Array.isArray(course.assignedMemberUids)
        ? [...new Set(course.assignedMemberUids.filter((uid) => typeof uid === "string" && uid).slice(0, 100))]
        : [];
      for (const memberUid of memberUids) {
        const assignmentId = courseAssignmentDocId(courseId, memberUid);
        if (assignmentsById.has(assignmentId)) continue;
        const assignment = { id: assignmentId, courseId, memberUid };
        batch.set(doc(db, "courseAssignments", assignmentId), {
          courseId,
          memberUid,
          assignedAt: serverTimestamp()
        });
        assignmentsById.set(assignmentId, assignment);
      }
    }
    batch.update(doc(db, "courses", courseId), updates);
    await batch.commit();
  }
}

async function loadSchedule() {
  try {
    const snapshot = await getDocs(collection(db, "schedule"));
    const saved = snapshot.docs.map((item) => ({ id: item.id, persisted: true, ...item.data() }));
    state.onlineScheduleSessions = saved
      .filter((item) => item.isOnlineSession === true && item.status !== "cancelled")
      .sort((a, b) => {
        const aEnded = a.status === "ended";
        const bEnded = b.status === "ended";
        if (aEnded !== bEnded) return aEnded ? 1 : -1;
        const aTime = a.startsAt?.toDate ? a.startsAt.toDate().getTime() : new Date(a.startsAt || 0).getTime();
        const bTime = b.startsAt?.toDate ? b.startsAt.toDate().getTime() : new Date(b.startsAt || 0).getTime();
        return aEnded ? bTime - aTime : aTime - bTime;
      });
    const weeklySchedule = saved.filter((item) => item.isOnlineSession !== true);
    state.schedule = weeklySchedule.length
      ? weeklySchedule.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")))
      : DEFAULT_SESSIONS.map((session) => ({ ...session, persisted: false }));
  } catch (error) {
    state.schedule = DEFAULT_SESSIONS.map((session) => ({ ...session, persisted: false }));
    state.onlineScheduleSessions = [];
    if (page === "admin") showToast("Saved schedule could not be loaded; showing defaults.", "error");
  }
  renderOnlineSessionSchedule();
  updateLiveCalendarUI();
}

function renderOnlineSessionSchedule() {
  const list = $("onlineScheduleList");
  if (!list) return;
  if (!state.onlineScheduleSessions.length) {
    list.innerHTML = '<div class="empty-state">No NawrasOnline rooms are scheduled right now.</div>';
    return;
  }
  list.innerHTML = state.onlineScheduleSessions.map((session) => {
    const date = session.startsAt?.toDate
      ? session.startsAt.toDate()
      : new Date(session.startsAt || `${new Date().toISOString().slice(0, 10)}T${session.start || "00:00"}`);
    const dateText = Number.isNaN(date.getTime())
      ? "Time to be announced"
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    const status = session.status === "live" ? "Live now" : session.status === "ended" ? "Ended" : "Scheduled";
    const joinUrl = session.status === "ended" ? "" : primaryDomainSessionUrl(session.attendUrl || "");
    const name = session.audienceRole === "all" ? session.name : "Private team video session";
    return `<article class="online-schedule-card">
      <div class="online-schedule-copy">
        <div class="online-schedule-meta"><span class="online-schedule-status is-${escapeAttr(session.status || "scheduled")}">${status}</span><span>${escapeHtml(dateText)}</span></div>
        <h3>${escapeHtml(name || "NawrasOnline session")}</h3>
        <p>${session.audienceRole === "all" ? "Open to all active team members." : "Sign in with an eligible team account to join."}</p>
      </div>
      ${joinUrl ? `<a class="btn btn-primary btn-small" href="${escapeAttr(joinUrl)}">Open session ↗</a>` : '<span class="online-schedule-ended">Room ended</span>'}
    </article>`;
  }).join("");
}

function formatSessionTime(session) {
  const format = (value) => {
    const [hour, minute] = String(value || "00:00").split(":").map(Number);
    const suffix = hour >= 12 ? "PM" : "AM";
    const twelveHour = hour % 12 || 12;
    return `${twelveHour}:${String(minute).padStart(2, "0")} ${suffix}`;
  };
  return `${format(session.start)} – ${format(session.end)}`;
}

function dayName(day) {
  return DAY_NAMES[Number(day)] || "Thursday, Friday & Saturday";
}

function sessionOccursOnDay(session, day) {
  if (Array.isArray(session.daysOfWeek) && session.daysOfWeek.length) return session.daysOfWeek.map(Number).includes(Number(day));
  if (session.dayOfWeek !== undefined && session.dayOfWeek !== null && session.dayOfWeek !== "") return Number(session.dayOfWeek) === Number(day);
  // Legacy sessions did not store a day, so keep them recurring on all schedule days.
  return [4, 5, 6].includes(Number(day));
}

function renderTeamSchedule() {
  if (!refs.teamScheduleList) return;
  refs.teamScheduleList.innerHTML = state.schedule.map((session) => `
    <div class="admin-item schedule-admin-item">
      <div class="schedule-admin-icon">◷</div>
       <div><h3>${escapeHtml(session.name)}</h3><p>${escapeHtml(dayName(session.dayOfWeek))} · ${escapeHtml(formatSessionTime(session))} · ${escapeHtml(session.tag)}${session.miroUrl ? " · Miro connected" : " · No board yet"}${session.attendUrl ? " · Attend link added" : ""}</p></div>
      <div class="admin-actions"><button class="btn btn-outline btn-compact" data-edit-schedule="${escapeAttr(session.id)}">Edit</button><button class="btn btn-danger btn-compact" data-delete-schedule="${escapeAttr(session.id)}">Delete</button></div>
    </div>`).join("") || `<div class="empty-state">No sessions yet. Add your first training session.</div>`;
  refs.teamScheduleList.querySelectorAll("[data-edit-schedule]").forEach((button) => button.addEventListener("click", () => openScheduleEditor(state.schedule.find((item) => item.id === button.dataset.editSchedule))));
  refs.teamScheduleList.querySelectorAll("[data-delete-schedule]").forEach((button) => button.addEventListener("click", () => deleteSchedule(button.dataset.deleteSchedule)));
}

function openScheduleEditor(session = null) {
  resetScheduleForm();
  if (session) {
    $("scheduleModalTitle").textContent = "Edit training session";
    $("scheduleId").value = session.id || "";
    $("scheduleName").value = session.name || "";
    $("scheduleTag").value = session.tag || "";
    $("scheduleDayOfWeek").value = String(session.dayOfWeek || 4);
    $("scheduleStart").value = session.start || "";
    $("scheduleEnd").value = session.end || "";
    $("scheduleMiroUrl").value = session.miroUrl || "";
    $("scheduleAttendUrl").value = session.attendUrl || "";
    $("scheduleMiroTitle").value = session.miroTitle || "";
    $("scheduleDescription").value = session.description || "";
  }
  openModal("scheduleModal");
}

function resetScheduleForm() {
  if (!$("scheduleForm")) return;
  $("scheduleForm").reset();
  $("scheduleModalTitle").textContent = "Add training session";
  $("scheduleId").value = "";
  $("scheduleDayOfWeek").value = "4";
}

async function deleteSchedule(id) {
  const session = state.schedule.find((item) => item.id === id);
  if (!session || !confirm(`Delete “${session.name}” from the schedule?`)) return;
  if (session.persisted === false) return showToast("This is a default session. Edit and save it first, then you can delete it.", "error");
  try {
    await deleteDoc(doc(db, "schedule", id));
    showToast("Training session deleted.");
    await loadSchedule();
    renderTeamSchedule();
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

function setCount(node, value) {
  if (node) node.textContent = String(value);
}

function sortByCreatedDesc(a, b, field = "createdAt") {
  return (b[field]?.seconds || 0) - (a[field]?.seconds || 0);
}

function sortByCreatedAsc(a, b, field = "createdAt") {
  return (a[field]?.seconds || 0) - (b[field]?.seconds || 0);
}

function renderPublicCourses(items) {
  if (!refs.publicCoursesGrid) return;
  refs.publicCoursesGrid.innerHTML = items.length ? items.map(courseCard).join("") : `<div class="empty-card">No matching courses found.</div>`;
  refs.publicCoursesGrid.querySelectorAll("[data-open-course-card]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea")) return;
      openCourseDetails(card.dataset.openCourseCard);
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("a, button, input, select, textarea")) {
        event.preventDefault();
        openCourseDetails(card.dataset.openCourseCard);
      }
    });
  });
}

function renderPublicForms(items) {
  if (!refs.publicFormsGrid) return;
  refs.publicFormsGrid.innerHTML = items.length ? items.map(formCard).join("") : `<div class="empty-card">لا توجد نماذج منشورة حاليًا.</div>`;
  refs.publicFormsGrid.querySelectorAll("[data-open-form-card]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea")) return;
      openPublicForm(card.dataset.openFormCard);
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("a, button, input, select, textarea")) {
        event.preventDefault();
        openPublicForm(card.dataset.openFormCard);
      }
    });
  });
  refs.publicFormsGrid.querySelectorAll("[data-open-form]").forEach((button) => button.addEventListener("click", () => openPublicForm(button.dataset.openForm)));
  refs.publicFormsGrid.querySelectorAll("[data-share-form]").forEach((button) => button.addEventListener("click", () => copyFormLink(button.dataset.shareForm)));
}

function renderMemberForms(items, failed = false) {
  personalPlanner?.refreshOverview();
  if (!refs.memberFormsList) return;
  if (refs.memberFormsCount) refs.memberFormsCount.textContent = `${items.length} form${items.length === 1 ? "" : "s"}`;
  refs.memberFormsList.innerHTML = items.length
    ? items.map(formCard).join("")
    : `<div class="empty-state">${failed ? "Your assigned forms could not be loaded. Check that the latest Firestore rules are deployed." : "No forms have been assigned to your team or university yet."}</div>`;
  refs.memberFormsList.querySelectorAll("[data-open-form-card]").forEach((card) => {
    const open = () => { window.location.href = formShareUrl(card.dataset.openFormCard); };
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button, input, select, textarea")) return;
      open();
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("a, button, input, select, textarea")) {
        event.preventDefault();
        open();
      }
    });
  });
  refs.memberFormsList.querySelectorAll("[data-open-form]").forEach((button) => button.addEventListener("click", () => {
    window.location.href = formShareUrl(button.dataset.openForm);
  }));
  refs.memberFormsList.querySelectorAll("[data-share-form]").forEach((button) => {
    button.addEventListener("click", () => copyFormLink(button.dataset.shareForm));
  });
}

function cardImage(url, alt) {
  return url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy" referrerpolicy="no-referrer">` : `<div class="image-placeholder" aria-hidden="true">${materialIcon("auto_awesome")}</div>`;
}

function courseCard(course) {
  const whatsappUrl = courseWhatsappUrl(course);
  const ctaUrl = normalizeHttpUrl(course.ctaUrl || "");
  const ctaButton = ctaUrl && course.ctaText
    ? `<a class="btn btn-outline btn-compact" href="${escapeAttr(ctaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(course.ctaText)} ↗</a>`
    : "";
  const whatsappButton = whatsappUrl
    ? `<a class="btn btn-secondary btn-compact whatsapp-course-button" href="${escapeAttr(whatsappUrl)}" target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>`
    : "";
  return `<article class="content-card course-content-card" data-open-course-card="${escapeAttr(course.id)}" tabindex="0" role="group" aria-label="${escapeAttr(`View course details: ${course.title || ""}`)}"><div class="content-card-media">${cardImage(course.imageUrl, course.title)}</div><div class="content-card-body">${course.category ? `<span class="card-tag">${escapeHtml(course.category)}</span>` : ""}<h3>${escapeHtml(course.title)}</h3>${course.price ? `<div class="course-price">${escapeHtml(course.price)}</div>` : ""}<p>${escapeHtml(course.description)}</p><div class="card-footer course-card-footer"><span class="muted">NAWRAS EDU</span><span class="card-arrow" aria-hidden="true">${materialIcon("open_in_new")}</span></div>${whatsappButton || ctaButton ? `<div class="course-card-actions">${whatsappButton}${ctaButton}</div>` : ""}</div></article>`;
}

function courseWhatsappUrl(course) {
  const phone = String(course.whatsappPhone || "").replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15) return "";
  const message = `Hi, I'm interested in ${course.title || "this course"}.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function openCourseDetails(id) {
  const course = state.courses.find((item) => item.id === id)
    || state.assignedCourses.find((item) => item.id === id);
  if (!course) return;
  const { modal, details } = ensureCourseDetailsModal();
  const whatsappUrl = courseWhatsappUrl(course);
  const ctaUrl = normalizeHttpUrl(course.ctaUrl || "");
  const isAssignedToCurrentMember = state.assignedCourses.some((item) => item.id === course.id);
  const canViewPrivateCourseContent = page === "admin"
    && state.isTeam
    && (canReadCourses() || canManageContent() || isAssignedToCurrentMember);
  const assets = canViewPrivateCourseContent && Array.isArray(course.assets)
    ? course.assets.filter((asset) =>
      asset && typeof asset.title === "string"
      && ((typeof asset.url === "string" && normalizeHttpUrl(asset.url)) || Boolean(asset.driveFileId))
    )
    : [];
  const buttons = [
    whatsappUrl ? `<a class="btn btn-secondary" href="${escapeAttr(whatsappUrl)}" target="_blank" rel="noopener noreferrer">Contact on WhatsApp ↗</a>` : "",
    ctaUrl && course.ctaText ? `<a class="btn btn-primary" href="${escapeAttr(ctaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(course.ctaText)} ↗</a>` : ""
  ].filter(Boolean).join("");
  const assetsMarkup = assets.length
    ? `<section class="course-preview-library" aria-label="Course lessons and materials">
        <div class="course-preview-library-heading"><div><span class="panel-kicker">YOUR COURSE LIBRARY</span><h3>Lessons &amp; materials</h3></div><p>${assets.length} resource${assets.length === 1 ? "" : "s"} · Select one to preview</p></div>
        <div class="course-preview-layout">
          <nav class="course-resource-nav" aria-label="Choose a lesson or material">${assets.map(courseAssetButtonMarkup).join("")}</nav>
          <div class="course-preview-stage" id="courseAssetPreviewPanel">${courseAssetMarkup(assets[0])}</div>
        </div>
      </section>`
    : canViewPrivateCourseContent
      ? `<div class="course-preview-no-assets"><span class="course-preview-no-assets-icon" aria-hidden="true">▤</span><div><strong>Course materials are on their way</strong><p>Your lessons and resources will appear here when they’re added.</p></div></div>`
      : "";
  details.innerHTML = `<div class="course-preview-shell">
    <section class="course-preview-hero">
      <div class="course-preview-cover">${cardImage(course.imageUrl, course.title)}<span class="course-cover-badge">${materialIcon("auto_awesome")} COURSE PREVIEW</span></div>
      <div class="course-preview-intro">
        <div class="course-preview-kickers">${course.category ? `<span class="course-preview-category">${escapeHtml(course.category)}</span>` : ""}<span class="course-preview-brand">NAWRAS EDU</span></div>
        <h2 id="publicCourseTitle">${escapeHtml(course.title)}</h2>
        <p class="course-preview-description">${escapeHtml(course.description)}</p>
        ${course.price ? `<div class="course-price course-modal-price">${escapeHtml(course.price)}</div>` : ""}
        ${buttons ? `<div class="course-details-actions">${buttons}</div>` : ""}
      </div>
    </section>
    ${assetsMarkup}
  </div>`;
  const resourceButtons = [...details.querySelectorAll("[data-course-asset-select]")];
  const previewPanel = details.querySelector("#courseAssetPreviewPanel");
  resourceButtons.forEach((button) => button.addEventListener("click", () => {
    const asset = assets[Number(button.dataset.courseAssetSelect)];
    if (!asset || !previewPanel) return;
    resourceButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    previewPanel.innerHTML = courseAssetMarkup(asset);
    const drivePreviewButton = previewPanel.querySelector("[data-preview-course-drive]");
    drivePreviewButton?.addEventListener("click", () => {
      void openDrivePreview("courseAsset", course.id, asset.driveFileId, asset.title, asset.driveMimeType || "");
    });
  }));
  const firstDrivePreviewButton = previewPanel?.querySelector("[data-preview-course-drive]");
  if (firstDrivePreviewButton) {
    const firstAsset = assets[0];
    firstDrivePreviewButton.addEventListener("click", () => {
      void openDrivePreview("courseAsset", course.id, firstAsset.driveFileId, firstAsset.title, firstAsset.driveMimeType || "");
    });
  }
  modal.setAttribute("aria-labelledby", "publicCourseTitle");
  openModal("publicCourseModal");
}

function ensureCourseDetailsModal() {
  let modal = $("publicCourseModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "publicCourseModal";
    modal.className = "modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="modal-backdrop" data-close-modal="publicCourseModal"></div><div class="modal-card modal-wide course-details-modal"><button class="modal-close" type="button" data-close-modal="publicCourseModal" aria-label="Close">×</button><div id="publicCourseDetails"></div></div>`;
    document.body.appendChild(modal);
  }
  modal.classList.add("course-preview-modal");
  modal.querySelector(".modal-card")?.classList.add("modal-wide", "course-details-modal");
  let details = $("publicCourseDetails");
  if (!details) {
    details = document.createElement("div");
    details.id = "publicCourseDetails";
    modal.querySelector(".modal-card")?.appendChild(details);
  }
  return { modal, details };
}

function courseAssetKindLabel(kind) {
  return ({
    video: "Video lesson",
    session: "Session",
    book: "Book / reading",
    material: "Material",
    link: "Resource link"
  })[kind] || "Course resource";
}

function courseAssetIcon(kind) {
  return ({
    video: "play_circle",
    session: "schedule",
    book: "menu_book",
    material: "description",
    link: "open_in_new"
  })[kind] || "folder_open";
}

function courseAssetButtonMarkup(asset, index) {
  const selected = index === 0;
  return `<button class="course-resource-button${selected ? " is-selected" : ""}" type="button" data-course-asset-select="${index}" aria-pressed="${selected}">
    <span class="course-resource-icon">${materialIcon(courseAssetIcon(asset.kind))}</span>
    <span class="course-resource-button-copy"><strong>${escapeHtml(asset.title)}</strong><small>${escapeHtml(courseAssetKindLabel(asset.kind))}</small></span>
    <span class="course-resource-chevron">${materialIcon("chevron_right")}</span>
  </button>`;
}

function ensureDrivePreviewModal() {
  let modal = $("drivePreviewModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "drivePreviewModal";
    modal.className = "modal hidden drive-preview-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="modal-backdrop" data-close-modal="drivePreviewModal"></div><div class="modal-card modal-wide drive-preview-card"><button class="modal-close" type="button" data-close-modal="drivePreviewModal" aria-label="Close preview">×</button><span class="eyebrow" id="drivePreviewType">Google Drive</span><h2 id="drivePreviewTitle">Resource preview</h2><div id="drivePreviewBody" class="drive-preview-body"></div></div>`;
    document.body.appendChild(modal);
  }
  return modal;
}

function closeDrivePreview() {
  const body = $("drivePreviewBody");
  if (body) body.replaceChildren();
  closeModal("drivePreviewModal");
}

function openLegacyDrivePreview(url, title) {
  const previewUrl = googleDrivePreviewUrl(url);
  if (!previewUrl) return showToast("This Drive link cannot be previewed. Check the file link.", "error");
  ensureDrivePreviewModal();
  $("drivePreviewTitle").textContent = title || "Resource preview";
  $("drivePreviewType").textContent = "Existing Google Drive link";
  $("drivePreviewBody").innerHTML = `<div class="drive-preview-stage"><iframe class="drive-preview-frame" src="${escapeAttr(previewUrl)}" title="${escapeAttr(title || "Google Drive file")}" loading="lazy" referrerpolicy="no-referrer"></iframe></div><div class="drive-preview-footer"><span>Uses the current Google Drive sharing settings.</span><a class="btn btn-outline btn-compact" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open in Drive ↗</a></div>`;
  openModal("drivePreviewModal");
}

async function openDrivePreview(sourceType, sourceId, fileId, title, mimeType = "") {
  const modal = ensureDrivePreviewModal();
  $("drivePreviewTitle").textContent = title || "Resource preview";
  $("drivePreviewType").textContent = mimeType.startsWith("video/") ? "Video"
    : mimeType.startsWith("image/") ? "Image"
      : mimeType === "application/pdf" || mimeType.startsWith("application/vnd.google-apps.") ? "Document"
        : "File";
  $("drivePreviewBody").innerHTML = `<div class="empty-state" role="status">Checking access and loading the file…</div>`;
  openModal("drivePreviewModal");
  try {
    const ticket = await requestDrivePreviewTicket(auth, sourceType, sourceId, fileId);
    const mime = ticket.mimeType || mimeType || "";
    const resourceName = ticket.fileName || title || "Academy resource";
    const url = ticket.url;
    let content = "";
    if (mime.startsWith("video/")) {
      content = `<video class="drive-preview-media" controls playsinline preload="metadata" src="${escapeAttr(url)}"></video>`;
    } else if (mime.startsWith("image/")) {
      content = `<img class="drive-preview-image" src="${escapeAttr(url)}" alt="${escapeAttr(resourceName)}" referrerpolicy="no-referrer">`;
    } else if (mime === "application/pdf" || mime.startsWith("application/vnd.google-apps.")) {
      content = `<iframe class="drive-preview-frame" src="${escapeAttr(url)}" title="${escapeAttr(resourceName)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    } else if (mime.startsWith("text/")) {
      content = `<iframe class="drive-preview-frame" src="${escapeAttr(url)}" title="${escapeAttr(resourceName)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
    } else {
      content = `<div class="drive-preview-download"><span class="drive-preview-file-icon" aria-hidden="true">${materialIcon("description")}</span><strong>${escapeHtml(resourceName)}</strong><p>This file type opens as a download. It remains private and this link expires after one hour.</p></div>`;
    }
    $("drivePreviewBody").innerHTML = `<div class="drive-preview-stage">${content}</div><div class="drive-preview-footer"><span>${escapeHtml(resourceName)}</span><a class="btn btn-outline btn-compact" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" download>Open or download</a></div>`;
  } catch (error) {
    $("drivePreviewBody").innerHTML = `<div class="empty-state drive-preview-error">${escapeHtml(error.message || "This file could not be opened.")}</div>`;
  }
}

function googleDrivePreviewUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (!["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())) return "";
    const fileId = url.pathname.match(/\/(?:file|document|spreadsheets|presentation|drawings)(?:\/u\/\d+)?\/d\/([^/]+)/i)?.[1]
      || url.searchParams.get("id")
      || "";
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return "";
    const preview = new URL(`https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`);
    const resourceKey = url.searchParams.get("resourcekey");
    if (resourceKey && /^[a-zA-Z0-9_-]+$/.test(resourceKey)) preview.searchParams.set("resourcekey", resourceKey);
    return preview.href;
  } catch (_) {
    return "";
  }
}

function youtubePreviewUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    let videoId = "";
    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      videoId = url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/i)?.[1] || "";
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? `https://www.youtube-nocookie.com/embed/${videoId}` : "";
  } catch (_) {
    return "";
  }
}

function vimeoPreviewUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (!["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) return "";
    const videoId = url.pathname.match(/(?:video\/)?(\d+)/)?.[1] || "";
    return /^\d+$/.test(videoId) ? `https://player.vimeo.com/video/${videoId}` : "";
  } catch (_) {
    return "";
  }
}

function courseAssetPreviewContent(asset, url) {
  const title = escapeAttr(asset.title || "Course resource");
  const driveUrl = googleDrivePreviewUrl(url);
  if (driveUrl) {
    return `<div class="course-preview-embed-wrap"><iframe class="course-preview-embed" src="${escapeAttr(driveUrl)}" title="${title}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><p class="course-preview-note">If the preview is blocked, open the original file and check its Google Drive sharing access.</p>`;
  }
  if (asset.kind === "video") {
    const videoEmbed = youtubePreviewUrl(url) || vimeoPreviewUrl(url);
    if (videoEmbed) {
      return `<div class="course-preview-embed-wrap"><iframe class="course-preview-embed" src="${escapeAttr(videoEmbed)}" title="${title}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    }
  }
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch (_) { /* normalized URL expected */ }
  if (asset.kind === "video" && /\.(mp4|m4v|webm|ogv|ogg|mov)$/.test(path)) {
    return `<div class="course-preview-embed-wrap"><video class="course-preview-media" controls playsinline preload="metadata"><source src="${escapeAttr(url)}"></video></div>`;
  }
  if (/\.(pdf)$/.test(path)) {
    return `<div class="course-preview-embed-wrap"><iframe class="course-preview-embed" src="${escapeAttr(url)}" title="${title}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  }
  if (/\.(png|jpe?g|webp|gif|avif)$/.test(path)) {
    return `<div class="course-preview-image-wrap"><img class="course-preview-image" src="${escapeAttr(url)}" alt="${title}" loading="lazy" referrerpolicy="no-referrer"></div>`;
  }
  if (/\.(mp3|wav|m4a|aac|oga)$/.test(path)) {
    return `<div class="course-preview-audio"><span class="course-preview-audio-icon" aria-hidden="true">${materialIcon("headphones")}</span><p>Audio resource</p><audio controls preload="metadata"><source src="${escapeAttr(url)}"></audio></div>`;
  }
  return `<div class="course-preview-unavailable"><span class="course-preview-unavailable-icon" aria-hidden="true">${materialIcon(courseAssetIcon(asset.kind))}</span><strong>Ready when you are</strong><p>This resource opens on its original site. Use the button below to view it.</p></div>`;
}

function courseAssetMarkup(asset) {
  const url = normalizeHttpUrl(asset.url);
  if (asset.driveFileId) {
    return `<article class="course-active-resource">
      <header class="course-active-resource-header"><div><span class="course-active-resource-kind">${escapeHtml(courseAssetKindLabel(asset.kind))}</span><h3>${escapeHtml(asset.title)}</h3></div><button class="btn btn-outline btn-compact course-resource-open" type="button" data-preview-course-drive="${escapeAttr(asset.driveFileId)}">Preview file</button></header>
      <div class="course-preview-unavailable"><span class="course-preview-unavailable-icon" aria-hidden="true">${materialIcon(courseAssetIcon(asset.kind))}</span><strong>${escapeHtml(asset.driveFileName || "Private course resource")}</strong><p>Open the protected in-site preview to view this course file.</p></div>
    </article>`;
  }
  if (!url) return "";
  return `<article class="course-active-resource">
    <header class="course-active-resource-header"><div><span class="course-active-resource-kind">${escapeHtml(courseAssetKindLabel(asset.kind))}</span><h3>${escapeHtml(asset.title)}</h3></div><a class="btn btn-outline btn-compact course-resource-open" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open original ↗</a></header>
    ${courseAssetPreviewContent(asset, url)}
  </article>`;
}

function formLanguage(form) {
  return form?.language === "en" ? "en" : "ar";
}

function showPrivateFormLoginGate(message = "") {
  const gate = $("privateFormLoginGate");
  const header = $("publicFormHeader");
  const root = $("publicForm");
  const success = $("publicFormSuccess");
  if (!gate) return showToast("Sign in to a team account to check access to this form.", "error");
  gate.classList.remove("hidden");
  header?.classList.add("hidden");
  root?.classList.add("hidden");
  success?.classList.add("hidden");
  if ($("privateFormLoginStatus")) $("privateFormLoginStatus").textContent = message;
  if ($("privateFormLoginForm")) $("privateFormLoginForm").querySelector('button[type="submit"]')?.removeAttribute("disabled");
  $("publicFormModal")?.setAttribute("aria-labelledby", "privateFormLoginTitle");
  openModal("publicFormModal");
  window.setTimeout(() => $("privateFormEmail")?.focus(), 0);
}

function formCard(form) {
  const language = formLanguage(form);
  const arabic = language === "ar";
  const audience = formAudienceType(form) === "public" ? "" : `<span class="card-tag form-audience-tag">${escapeHtml(formAudienceSummary(form))}</span>`;
  return `<article class="content-card form-content-card" data-open-form-card="${escapeAttr(form.id)}" tabindex="0" role="group" aria-label="${escapeAttr(arabic ? `فتح النموذج: ${form.title || ""}` : `Open form: ${form.title || ""}`)}" lang="${language}" dir="${arabic ? "rtl" : "ltr"}"><div class="content-card-media">${cardImage(form.imageUrl, form.title)}</div><div class="content-card-body"><span class="card-tag">${(form.fields || []).length} ${arabic ? "أسئلة" : "questions"}</span>${audience}<h3 dir="auto">${escapeHtml(form.title)}</h3><p class="form-card-description" dir="auto">${escapeHtml(form.description || (arabic ? "يرجى تعبئة هذا النموذج." : "Complete this form online."))}</p><div class="card-footer form-card-actions"><button class="btn btn-primary btn-compact" data-open-form="${escapeAttr(form.id)}">${arabic ? "تعبئة النموذج" : "Fill form"} <span>${arabic ? "←" : "→"}</span></button><button class="btn btn-outline btn-compact" type="button" data-share-form="${escapeAttr(form.id)}" aria-label="${arabic ? "نسخ رابط النموذج" : `Copy share link for ${escapeAttr(form.title)}`}">${arabic ? "مشاركة ↗" : "Share ↗"}</button></div></div></article>`;
}

function formShareUrl(id) {
  const url = new URL("./forms.html", window.location.href);
  url.searchParams.set("form", id);
  return url.href;
}

async function copyFormLink(id) {
  const link = formShareUrl(id);
  const form = [...state.forms, ...state.memberForms].find((item) => item.id === id);
  const shareMessage = form && formAudienceType(form) !== "public"
    ? `Private form link copied. Only signed-in members in ${formAudienceSummary(form)} can open it.`
    : "Public form link copied. Anyone with the link can open it.";
  try {
    await navigator.clipboard.writeText(link);
    showToast(shareMessage);
  } catch (_) {
    const copyField = document.createElement("textarea");
    copyField.value = link;
    copyField.setAttribute("readonly", "");
    copyField.style.position = "fixed";
    copyField.style.opacity = "0";
    document.body.appendChild(copyField);
    copyField.select();
    const copied = document.execCommand("copy");
    copyField.remove();
    if (copied) showToast(shareMessage);
    else window.prompt("Copy this form link to share it:", link);
  }
}

function renderTeamCourses(items) {
  if (!refs.teamCoursesList) return;
  if ($("addCourseBtn")) $("addCourseBtn").classList.toggle("hidden", !canManageCourses());
  refs.teamCoursesList.innerHTML = items.length ? items.map((course) => `
    <div class="admin-item"><div class="admin-thumb">${cardImage(course.imageUrl, "")}</div><div><h3>${escapeHtml(course.title)}</h3><p><span class="status-dot ${course.published === false ? "off" : ""}"></span>${course.published === false ? "Draft" : "Published"}${course.category ? ` · ${escapeHtml(course.category)}` : ""}</p></div><div class="admin-actions"><button class="btn btn-outline btn-compact" data-view-course="${escapeAttr(course.id)}">View</button>${canManageCourses() ? `<button class="btn btn-outline btn-compact" data-edit-course="${escapeAttr(course.id)}">Edit</button><button class="btn btn-danger btn-compact" data-delete-course="${escapeAttr(course.id)}">Delete</button>` : ""}</div></div>`).join("") : `<div class="empty-state">${canManageCourses() ? "No courses yet. Add your first course above." : "No courses are available in the library yet."}</div>`;
  refs.teamCoursesList.querySelectorAll("[data-view-course]").forEach((button) => button.addEventListener("click", () => openCourseDetails(button.dataset.viewCourse)));
  refs.teamCoursesList.querySelectorAll("[data-edit-course]").forEach((button) => button.addEventListener("click", () => openCourseEditor(state.courses.find((item) => item.id === button.dataset.editCourse))));
  refs.teamCoursesList.querySelectorAll("[data-delete-course]").forEach((button) => button.addEventListener("click", () => deleteCourse(button.dataset.deleteCourse)));
}

function renderTeamForms(items) {
  if (!refs.teamFormsList) return;
  if ($("addFormBtn")) $("addFormBtn").classList.toggle("hidden", !canManageForms());
  refs.teamFormsList.innerHTML = items.length ? items.map((form) => `
    <div class="admin-item"><div class="admin-thumb">${cardImage(form.imageUrl, "")}</div><div><h3>${escapeHtml(form.title)}</h3><p><span class="status-dot ${form.published === false ? "off" : ""}"></span>${form.published === false ? "Draft" : "Published"} · ${(form.fields || []).length} questions · ${escapeHtml(formAudienceSummary(form))}</p></div><div class="admin-actions">${canReadManagedForms() ? `<button class="btn btn-outline btn-compact" data-view-managed-form="${escapeAttr(form.id)}">View form</button>` : ""}${canReadFormResponses() ? `<button class="btn btn-secondary btn-compact" data-view-answers="${escapeAttr(form.id)}">View answers</button>` : ""}${canManageForms() ? `<button class="btn btn-outline btn-compact" data-share-form="${escapeAttr(form.id)}" ${form.published === false ? "disabled title=\"Publish this form before sharing its link.\"" : ""}>Copy link</button><button class="btn btn-outline btn-compact" data-edit-form="${escapeAttr(form.id)}">Edit</button>${form.published === false ? `<button class="btn btn-primary btn-compact" data-publish-form="${escapeAttr(form.id)}">Publish</button>` : ""}${canManageContent() ? `<button class="btn btn-danger btn-compact" data-delete-form="${escapeAttr(form.id)}">Delete</button>` : ""}` : ""}</div></div>`).join("") : `<div class="empty-state">${canManageForms() ? "No forms yet. Add your first form above." : "No forms are available to view."}</div>`;
  refs.teamFormsList.querySelectorAll("[data-view-managed-form]").forEach((button) => button.addEventListener("click", () => openPublicForm(button.dataset.viewManagedForm)));
  refs.teamFormsList.querySelectorAll("[data-share-form]").forEach((button) => button.addEventListener("click", () => copyFormLink(button.dataset.shareForm)));
  refs.teamFormsList.querySelectorAll("[data-view-answers]").forEach((button) => button.addEventListener("click", () => viewAnswers(button.dataset.viewAnswers)));
  refs.teamFormsList.querySelectorAll("[data-edit-form]").forEach((button) => button.addEventListener("click", () => openFormEditor(state.forms.find((item) => item.id === button.dataset.editForm))));
  refs.teamFormsList.querySelectorAll("[data-publish-form]").forEach((button) => button.addEventListener("click", () => publishForm(button.dataset.publishForm)));
  if (canManageForms()) refs.teamFormsList.querySelectorAll("[data-edit-form]").forEach((button) => {
    const actions = button.closest(".admin-actions");
    if (!actions.querySelector("[data-delete-form]")) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-danger btn-compact";
      remove.dataset.deleteForm = button.dataset.editForm;
      remove.textContent = "Delete";
      actions.appendChild(remove);
    }
  });
  refs.teamFormsList.querySelectorAll("[data-delete-form]").forEach((button) => button.addEventListener("click", () => deleteForm(button.dataset.deleteForm)));
}

async function deleteCourse(id) {
  if (!canManageCourses()) return showToast("You do not have permission to manage courses.", "error");
  const course = state.courses.find((item) => item.id === id);
  if (!course || !confirm(`Delete “${course.title}”?`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "courses", id));
    batch.delete(doc(db, "coursePrivate", id));
    state.courseAssignments
      .filter((assignment) => assignment.courseId === id)
      .forEach((assignment) => batch.delete(doc(db, "courseAssignments", assignment.id || courseAssignmentDocId(id, assignment.memberUid))));
    await batch.commit();
    showToast("Course deleted.");
    await loadTeamData();
  } catch (error) { showToast(firebaseError(error), "error"); }
}

async function deleteForm(id) {
  if (!canManageForms()) return showToast("You do not have permission to manage forms.", "error");
  const form = state.forms.find((item) => item.id === id);
  if (!form || !confirm(`Delete “${form.title}”? Existing response subcollections may need cleanup separately.`)) return;
  try {
    await deleteDoc(doc(db, "forms", id));
    showToast("Form deleted.");
    await loadTeamData();
  } catch (error) { showToast(firebaseError(error), "error"); }
}

async function publishForm(id) {
  if (!canManageForms()) return showToast("You do not have permission to manage forms.", "error");
  const form = state.forms.find((item) => item.id === id);
  if (!form || form.published !== false) return;
  try {
    await updateDoc(doc(db, "forms", id), { published: true, updatedAt: serverTimestamp() });
    let notificationError = null;
    if (formAudienceType(form) !== "public") {
      try {
        const count = await notifyFormAudience({ ...form, published: true });
        if (!count) notificationError = new Error("No active members currently match this audience.");
      } catch (error) {
        notificationError = error;
      }
    }
    showToast(notificationError
      ? `Form published, but its inbox notification was not delivered: ${firebaseError(notificationError)}`
      : `“${form.title}” is now published.`, notificationError ? "error" : "ok");
    if (canManageContent()) await loadTeamData();
    else await loadManagedForms();
  } catch (error) { showToast(firebaseError(error), "error"); }
}

async function saveFormResponse(form, answers) {
  const responseRef = doc(collection(db, "forms", form.id, "responses"));
  const batch = writeBatch(db);
  batch.set(responseRef, { answers, submittedAt: serverTimestamp(), formTitle: form.title });
  const ownerUid = typeof form.createdBy === "string" ? form.createdBy : "";
  let owner = null;
  if (ownerUid && ownerUid !== auth.currentUser?.uid) {
    try { owner = await getDoc(doc(db, "teamMembers", ownerUid)); }
    catch (_) { /* An unavailable/inactive creator must not block public submissions. */ }
  }
  if (owner?.exists() && owner.data().active === true) {
    batch.set(doc(db, "teamMembers", ownerUid, "notifications", `form-response_${form.id}_${responseRef.id}`), {
      type: "form_response", title: `New response: ${form.title}`.slice(0, 120),
      message: "Your form received a new submission. Open the dashboard to view its answers.",
      actorUid: "",
      actorName: "Form respondent",
      formId: form.id, responseId: responseRef.id, createdAt: serverTimestamp(), read: false
    });
  }
  await batch.commit();
}

async function openPublicForm(id) {
  let form = [...state.forms, ...state.memberForms].find((item) => item.id === id);
  // Public forms are already loaded into state. Avoid an extra Firestore round
  // trip on tap; mobile networks can make that request feel like the button did nothing.
  if (!form) {
    try {
      const snapshot = await getDoc(doc(db, "forms", id));
      if (snapshot.exists()) form = { id: snapshot.id, ...snapshot.data() };
    } catch (_) {}
  }
  if (!form || form.published === false) {
    if (page === "forms" && $("privateFormLoginGate")) {
      return showPrivateFormLoginGate(state.isTeam
        ? "This link could not be opened for your account. Confirm you belong to the form’s team or university group."
        : "");
    }
    return showToast("This form is not available.", "error");
  }
  if (!canCurrentMemberViewForm(form)) {
    if (page === "forms" && $("privateFormLoginGate")) {
      return showPrivateFormLoginGate("This account does not match the team or university group for this form.");
    }
    return showToast("This form is restricted to a different team or university group.", "error");
  }
  const header = $("publicFormHeader");
  const root = $("publicForm");
  const success = $("publicFormSuccess");
  $("privateFormLoginGate")?.classList.add("hidden");
  if ($("privateFormLoginStatus")) $("privateFormLoginStatus").textContent = "";
  if ($("privateFormLoginForm")) $("privateFormLoginForm").querySelector('button[type="submit"]')?.removeAttribute("disabled");
  const modal = $("publicFormModal");
  const modalCard = modal?.querySelector(".public-form-modal");
  if (!header || !root || !success) return;
  modal?.setAttribute("aria-labelledby", "publicFormTitle");
  header.classList.remove("hidden");
  root.classList.remove("hidden");
  success.classList.add("hidden");
  success.innerHTML = "";
  const language = formLanguage(form);
  const arabic = language === "ar";
  const direction = arabic ? "rtl" : "ltr";
  const ctaUrl = normalizeHttpUrl(form.ctaUrl || "");
  const ctaButton = ctaUrl && form.ctaText
    ? `<a class="btn btn-secondary public-form-cta" href="${escapeAttr(ctaUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(form.ctaText)} ↗</a>`
    : "";
  header.className = "public-form-header";
  header.lang = language;
  header.dir = direction;
  root.lang = language;
  root.dir = direction;
  if (modal) {
    modal.lang = language;
    modal.dir = direction;
  }
  if (modalCard) {
    modalCard.lang = language;
    modalCard.dir = direction;
  }
  header.innerHTML = `${form.imageUrl ? `<img src="${escapeAttr(form.imageUrl)}" alt="${escapeAttr(form.title)}">` : ""}<div class="public-form-heading-copy"><span class="eyebrow">${arabic ? "نموذج إلكتروني" : "Online form"}</span><h2 id="publicFormTitle" dir="auto">${escapeHtml(form.title)}</h2>${form.description ? `<p class="public-form-description" dir="auto">${escapeHtml(form.description)}</p>` : `<p class="public-form-description">${arabic ? "يرجى تعبئة النموذج أدناه." : "Please complete the form below."}</p>`}${ctaButton}</div>`;
  const fields = form.fields || [];
  root.innerHTML = `<div class="public-form-progress" aria-live="polite"><div class="public-form-progress-copy"><span>${arabic ? "تقدمك في النموذج" : "YOUR PROGRESS"}</span><strong data-progress-label>${arabic ? `تمت الإجابة على 0 من ${fields.length} أسئلة` : `0 of ${fields.length} questions complete`}</strong></div><div class="public-form-progress-track"><span data-progress-fill></span></div></div>${fields.map((field, index) => renderPublicField(field, index, language)).join("")}<button class="btn btn-primary btn-block public-form-submit" type="submit">${arabic ? "إرسال النموذج" : "Submit form"} <span>${arabic ? "←" : "→"}</span></button>`;
  const updateProgress = () => {
    root.querySelectorAll(".rating-stars").forEach((group) => {
      const selectedRating = Number(group.querySelector("input:checked")?.value || 0);
      group.querySelectorAll(".rating-star").forEach((star, index) => {
        star.classList.toggle("is-highlighted", index < selectedRating);
      });
    });
    const answered = fields.filter((field) => {
      const inputs = Array.from(root.querySelectorAll(`[name="${cssEscape(field.id)}"]`));
      return ["checkbox", "radio", "multiselect", "rating"].includes(field.type)
        ? inputs.some((input) => input.checked)
        : inputs.some((input) => String(input.value || "").trim().length > 0);
    }).length;
    const percent = fields.length ? Math.round(answered / fields.length * 100) : 0;
    root.querySelector("[data-progress-fill]")?.style.setProperty("width", `${percent}%`);
    const label = root.querySelector("[data-progress-label]");
    if (label) label.textContent = arabic
      ? `تمت الإجابة على ${answered} من ${fields.length} أسئلة`
      : `${answered} of ${fields.length} questions complete`;
  };
  root.querySelectorAll("input, textarea, select").forEach((input) => {
    input.addEventListener("input", updateProgress);
    input.addEventListener("change", updateProgress);
  });
  updateProgress();
  root.onsubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData(root);
    const answers = {};
    for (const field of fields) {
      const values = root.querySelectorAll(`[name="${cssEscape(field.id)}"]`);
      const answerGroup = Array.from(values);
      const answered = ["checkbox", "radio", "multiselect", "rating"].includes(field.type)
        ? answerGroup.some((input) => input.checked)
        : answerGroup.some((input) => String(input.value || "").trim());
      if (field.required && !answered) {
        return showToast(arabic ? `يرجى الإجابة عن: ${field.label}` : `Please complete: ${field.label}`, "error");
      }
      answers[field.id] = field.type === "multiselect"
        ? answerGroup.filter((input) => input.checked).map((input) => input.value)
        : field.type === "checkbox"
          ? (values[0]?.checked ? values[0].value : "")
          : (formData.get(field.id) ?? "");
    }
    try {
      const submitButton = root.querySelector('[type="submit"]');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = arabic ? "جارٍ إرسال إجابتك…" : "Sending your response…";
      }
      await saveFormResponse(form, answers);
      root.reset();
      header.classList.add("hidden");
      root.classList.add("hidden");
      success.lang = language;
      success.dir = direction;
      success.innerHTML = `<div class="success-confetti" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div><span class="completion-party material-symbols-outlined" aria-hidden="true">celebration</span><span class="eyebrow">${arabic ? "تم بنجاح" : "All done!"}</span><h2>${arabic ? "تم إرسال الإجابة" : "Response submitted"}</h2><p>${arabic ? `شكرًا لإكمال <strong>${escapeHtml(form.title)}</strong>. تم إرسال إجابتك إلى فريق NAWRAS EDU.` : `Thank you for completing <strong>${escapeHtml(form.title)}</strong>. Your response has been sent to the NAWRAS EDU team.`}</p><button class="btn btn-primary" type="button" data-close-modal="publicFormModal">${arabic ? "تم" : "Done"} ${materialIcon("task_alt")}</button>`;
      success.classList.remove("hidden");
    } catch (error) {
      const submitButton = root.querySelector('[type="submit"]');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = `${arabic ? "إرسال النموذج" : "Submit form"} <span>${arabic ? "←" : "→"}</span>`;
      }
      showToast(firebaseError(error), "error");
    }
  };
  openModal("publicFormModal");
}

function renderPublicField(field, index = 0, language = "ar") {
  const required = field.required ? "required" : "";
  const fieldId = escapeAttr(field.id);
  const labelId = `field-label-${fieldId}`;
  const label = `${escapeHtml(field.label)}${field.required ? " *" : ""}`;
  const animation = `style="--field-index:${index};animation-delay:${Math.min(index * 65, 520)}ms"`;
  if (field.type === "textarea") return `<div class="public-field" ${animation}><label dir="auto">${label}<textarea dir="auto" name="${fieldId}" rows="4" ${required}></textarea></label></div>`;
  if (field.type === "select") return `<div class="public-field" ${animation}><label dir="auto">${label}<select dir="auto" name="${fieldId}" ${required}><option value="">${language === "ar" ? "اختر خيارًا" : "Choose an option"}</option>${(field.options || []).map((option) => `<option value="${escapeAttr(option)}">${escapeHtml(option)}</option>`).join("")}</select></label></div>`;
  if (field.type === "radio" || field.type === "multiselect") {
    const inputType = field.type === "radio" ? "radio" : "checkbox";
    return `<div class="public-field" ${animation} role="group" aria-labelledby="${labelId}"><div class="public-field-question" id="${labelId}" dir="auto">${label}</div><span class="option-list">${(field.options || []).map((option) => `<label class="option-item"><input type="${inputType}" name="${fieldId}" value="${escapeAttr(option)}" ${field.type === "radio" ? required : ""}><span dir="auto">${escapeHtml(option)}</span></label>`).join("")}</span></div>`;
  }
  if (field.type === "rating") {
    const stars = Array.from({ length: 5 }, (_, index) => {
      const score = index + 1;
      const ratingLabel = language === "ar" ? `${score} من 5 نجوم` : `${score} out of 5 stars`;
      return `<label class="rating-star" title="${ratingLabel}"><input type="radio" name="${fieldId}" value="${score}" aria-label="${ratingLabel}" ${required}><span class="material-symbols-outlined" aria-hidden="true">star</span></label>`;
    }).join("");
    return `<div class="public-field" ${animation} role="group" aria-labelledby="${labelId}"><div class="public-field-question" id="${labelId}" dir="auto">${label}</div><div class="rating-stars" role="radiogroup" aria-labelledby="${labelId}">${stars}</div></div>`;
  }
  if (field.type === "checkbox") return `<div class="public-field" ${animation} role="group" aria-labelledby="${labelId}"><div class="public-field-question" id="${labelId}" dir="auto">${label}</div><span class="option-list"><label class="option-item"><input type="checkbox" name="${fieldId}" value="Yes" ${required}><span>${language === "ar" ? "نعم" : "Yes"}</span></label></span></div>`;
  return `<div class="public-field" ${animation}><label dir="auto">${label}<input dir="auto" type="${escapeAttr(field.type)}" name="${fieldId}" ${required}></label></div>`;
}

async function viewAnswers(formId) {
  if (!state.isTeam || !canReadFormResponses() || !refs.responsesViewer || !refs.emptyResponsesState) return;
  const form = state.forms.find((item) => item.id === formId);
  if (!form) return;
  state.activeDashboardSection = "responses";
  renderDashboard();
  refs.emptyResponsesState.classList.add("hidden");
  refs.responsesViewer.classList.remove("hidden");
  refs.responsesViewer.innerHTML = `<div class="empty-state">Loading answers…</div>`;
  try {
    let snapshot;
    try { snapshot = await getDocs(query(collection(db, "forms", formId, "responses"), orderBy("submittedAt", "desc"))); }
    catch (_) { snapshot = await getDocs(collection(db, "forms", formId, "responses")); }
    const responses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    const columns = (form.fields || []).map((field) => ({ id: field.id, label: field.label }));
    const rows = responses.map((response) => `<tr><td>${formatDate(response.submittedAt)}</td>${columns.map((column) => `<td>${formatAnswer(response.answers?.[column.id])}</td>`).join("")}</tr>`).join("");
    refs.responsesViewer.innerHTML = `<div class="responses-toolbar"><button class="btn btn-outline btn-compact" id="printResponsesBtn">Print answers</button><button class="btn btn-secondary btn-compact" id="csvResponsesBtn">Download CSV</button></div><div class="panel-heading"><div><span class="panel-kicker">Submissions</span><h2>${escapeHtml(form.title)} — answers</h2></div><span class="panel-hint">${responses.length} submission${responses.length === 1 ? "" : "s"}</span></div>${responses.length ? `<div class="answer-table-wrap"><table class="answer-table"><thead><tr><th>Submitted</th>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state">No answers submitted yet.</div>`}`;
    $("printResponsesBtn").addEventListener("click", () => window.print());
    $("csvResponsesBtn").addEventListener("click", () => downloadCsv(form, responses));
  } catch (error) {
    refs.responsesViewer.innerHTML = `<div class="empty-state">Could not load answers.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function downloadCsv(form, responses) {
  const fields = form.fields || [];
  const rows = [["Submitted", ...fields.map((field) => field.label)]];
  responses.forEach((response) => rows.push([formatDate(response.submittedAt), ...fields.map((field) => Array.isArray(response.answers?.[field.id]) ? response.answers[field.id].join(", ") : (response.answers?.[field.id] ?? ""))]));
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url; link.download = `${safeFilename(form.title)}-answers.csv`; link.click(); URL.revokeObjectURL(url);
}

function formatDate(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : timestamp.seconds ? new Date(timestamp.seconds * 1000) : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
function formatAnswer(value) { return Array.isArray(value) ? value.map(escapeHtml).join(", ") : escapeHtml(String(value ?? "")); }
function humanFieldType(type) { return ({ text: "Short text", textarea: "Long text", email: "Email", number: "Number", date: "Date", select: "Dropdown", radio: "Single choice", multiselect: "Multiple choice", checkbox: "Yes / No", rating: "Star rating (1–5)" })[type] || type; }
function extractImageUrl(value) { if (!value) return ""; return value.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i)?.[1]?.trim() || value.trim(); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", "\"": "&quot;" })[character]); }
function materialIcon(name, className = "") {
  const safeName = /^[a-z_]+$/.test(String(name || "")) ? name : "help";
  const safeClass = String(className || "").replace(/[^a-z0-9 _-]/gi, "");
  return `<span class="material-symbols-outlined${safeClass ? ` ${safeClass}` : ""}" aria-hidden="true">${safeName}</span>`;
}
function upgradeStaticIcons(root = document) {
  root.querySelectorAll(".success-mark").forEach((node) => {
    node.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "task_alt";
    node.appendChild(icon);
  });
  root.querySelectorAll(".visual-chip").forEach((node) => {
    const name = node.classList.contains("chip-one") ? "menu_book" : "groups";
    const oldMark = node.classList.contains("chip-one") ? "✦" : "◌";
    const label = node.textContent.replace(oldMark, "").trim();
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = name;
    node.replaceChildren(icon, document.createTextNode(label));
  });
  root.querySelectorAll(".social-arrow").forEach((node) => {
    node.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "open_in_new";
    node.appendChild(icon);
  });
  root.querySelectorAll("a.btn, button.btn, .back-link, .profile-back-link, .primary-nav a").forEach((element) => {
    for (const textNode of [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)) {
      const original = textNode.textContent || "";
      const lead = original.match(/^(\s*)([←→↗])(\s*)/);
      const tail = lead ? null : original.match(/(\s*)([←→↗])(\s*)$/);
      const match = lead || tail;
      if (!match) continue;
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = ({ "←": "arrow_back", "→": "arrow_forward", "↗": "open_in_new" })[match[2]];
      if (lead) {
        textNode.textContent = `${match[1]}${original.slice(match[0].length)}`;
        element.insertBefore(icon, textNode);
      } else {
        textNode.textContent = `${original.slice(0, -match[0].length)}${match[1]}`;
        element.insertBefore(icon, textNode.nextSibling);
      }
      break;
    }
  });
  root.querySelectorAll("button").forEach((button) => {
    for (const textNode of [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)) {
      const match = (textNode.textContent || "").match(/^(\s*)[＋+]\s*/);
      if (!match) continue;
      textNode.textContent = `${match[1]}${textNode.textContent.slice(match[0].length)}`;
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "add";
      button.insertBefore(icon, textNode);
      break;
    }
  });
}
function escapeAttr(value) { return escapeHtml(value); }
function cssEscape(value) { return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
function safeFilename(value) { return String(value || "form").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "form"; }
function csvEscape(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text; }
function friendlyAuthError(error) { return ({ "auth/invalid-credential": "Email or password is incorrect.", "auth/invalid-email": "Enter a valid email address.", "auth/too-many-requests": "Too many attempts. Try again later.", "auth/user-not-found": "No Firebase account was found for this email.", "auth/wrong-password": "Email or password is incorrect.", "auth/email-already-in-use": "An account already exists with this email. Try signing in instead.", "auth/weak-password": "Choose a stronger password with at least 8 characters.", "auth/operation-not-allowed": "Email and password registration is disabled. Enable Email/Password in Firebase Authentication settings.", "auth/network-request-failed": "Network error. Check your connection and try again." })[error?.code] || error?.message || "Authentication failed."; }
function firebaseError(error) { return error?.message || "Firebase operation failed."; }
function isProfilePermissionDenied(error) {
  return ["permission-denied", "firestore/permission-denied"].includes(String(error?.code || ""))
    || /missing or insufficient permissions/i.test(String(error?.message || ""));
}
function profileWriteError(error, subject) {
  return isProfilePermissionDenied(error)
    ? `Firestore denied saving ${subject}. Publish the latest firestore.rules to the same Firebase project used by this site.`
    : firebaseError(error);
}

let draggedDashboardPanel = null;
const DASHBOARD_PANEL_IDS = {
  roleWorkspace: "role-workspace",
  designerResourcesPanel: "role-resources",
  profilePanel: "profile",
  crossTeamWorkPanel: "cross-team-work",
  memberInboxPanel: "inbox",
  memberFormsPanel: "member-forms",
  leaderboardPanel: "leaderboard",
  tasksPanel: "tasks",
  questionsPanel: "questions",
  teamMembersPanel: "team-members",
  dashboardAccessPanel: "dashboard-access",
  ratingsPanel: "ratings",
  attendancePanel: "attendance",
  sessionsPanel: "sessions",
  chatPanel: "chat",
  sharedManagement: "management"
};

function flattenManagementPanels() {
  if (!refs.dashboardLayout || !refs.sharedManagement || refs.sharedManagement.dataset.panelsFlattened === "true") return;
  const panelDefinitions = [
    ["teamCoursesList", "courses"],
    ["teamFormsList", "forms"],
    ["responsesViewer", "responses"]
  ];
  panelDefinitions.forEach(([childId, panelId]) => {
    const panel = $(childId)?.closest(".panel");
    if (!panel || !refs.sharedManagement.contains(panel)) return;
    panel.dataset.dashboardPanel = panelId;
    panel.dataset.managementPanel = "true";
    refs.dashboardLayout.appendChild(panel);
  });
  refs.sharedManagement.querySelector(".dashboard-columns")?.classList.add("hidden");
  refs.sharedManagement.dataset.panelsFlattened = "true";
}

function dashboardPanelNodes() {
  if (!refs.dashboardLayout) return [];
  return Array.from(refs.dashboardLayout.children).filter((panel) => {
    if (!panel.dataset.dashboardPanel && DASHBOARD_PANEL_IDS[panel.id]) panel.dataset.dashboardPanel = DASHBOARD_PANEL_IDS[panel.id];
    return Boolean(panel.dataset.dashboardPanel);
  });
}

function dashboardLayoutKey() {
  const userId = state.user?.uid || "guest";
  const role = state.activeDashboardRole || state.role || "default";
  return `nawras-dashboard-layout:${userId}:${role}`;
}

function saveDashboardLayout() {
  const panels = dashboardPanelNodes();
  if (!panels.length) return;
  try {
    const collapsed = Object.fromEntries(panels.map((panel) => [panel.dataset.dashboardPanel, panel.classList.contains("is-collapsed")]));
    localStorage.setItem(dashboardLayoutKey(), JSON.stringify({
      order: panels.map((panel) => panel.dataset.dashboardPanel),
      collapsed
    }));
  } catch (_) {
    // Storage can be disabled in private browsing; the dashboard still works for this session.
  }
}

function setDashboardPanelCollapsed(panel, collapsed, persist = true) {
  panel.classList.toggle("is-collapsed", collapsed);
  const button = panel.querySelector(":scope > .panel-heading .panel-collapse-button, :scope > .profile-panel-heading .panel-collapse-button, :scope > .role-workspace-heading .panel-collapse-button, :scope > .dashboard-group-heading .panel-collapse-button");
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
    button.title = collapsed ? "Expand section" : "Collapse section";
    button.textContent = collapsed ? "⌄" : "⌃";
  }
  if (persist) saveDashboardLayout();
}

function restoreDashboardLayout() {
  const panels = dashboardPanelNodes();
  if (!panels.length || !refs.dashboardLayout) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(dashboardLayoutKey()) || "null");
  } catch (_) {
    saved = null;
  }
  if (saved?.order?.length) {
    const byId = new Map(panels.map((panel) => [panel.dataset.dashboardPanel, panel]));
    saved.order.forEach((id) => {
      const panel = byId.get(id);
      if (panel) refs.dashboardLayout.appendChild(panel);
    });
  }
  const collapsed = saved?.collapsed || {};
  dashboardPanelNodes().forEach((panel) => setDashboardPanelCollapsed(panel, Boolean(collapsed[panel.dataset.dashboardPanel]), false));
}

function dashboardPanelHeader(panel) {
  return Array.from(panel.children).find((child) =>
    child.classList.contains("panel-heading")
    || child.classList.contains("profile-panel-heading")
    || child.classList.contains("role-workspace-heading")
    || child.classList.contains("dashboard-group-heading")
  );
}

function setupDashboardLayout() {
  flattenManagementPanels();
}

function technicalMaterialKindLabel(kind) {
  return ({ video: "Video", lecture: "Lecture", book: "Book", material: "Material" })[kind] || "Material";
}

function technicalMaterialKindIcon(kind) {
  return ({ video: "play_circle", lecture: "cast_for_education", book: "menu_book", material: "description" })[kind] || "folder_open";
}

function normalizeGoogleDriveMaterialUrl(value) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  // A valid sharing link need not be embeddable (for example, a Drive folder).
  return url.protocol === "https:" && ["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())
    && (url.pathname !== "/" || url.search) ? normalized : "";
}

function technicalMaterialCardMarkup(material) {
  const label = technicalMaterialKindLabel(material.kind);
  const driveUrl = normalizeGoogleDriveMaterialUrl(material.url);
  const embeddedDriveUrl = driveUrl ? googleDrivePreviewUrl(driveUrl) : "";
  const adminAction = canManageTechnicalMaterials()
    ? `<button class="btn btn-outline btn-compact" type="button" data-edit-technical-material="${escapeAttr(material.id)}">Edit</button><button class="btn btn-danger btn-compact" type="button" data-delete-technical-material="${escapeAttr(material.id)}">Delete</button>`
    : "";
  const previewLabel = ["video", "lecture"].includes(material.kind) ? "Watch here" : "Preview here";
  const resourceActions = material.driveFileId
    ? `<button class="btn btn-primary btn-compact" type="button" data-preview-technical-material="${escapeAttr(material.id)}">${previewLabel}</button>`
    : embeddedDriveUrl
      ? `<button class="btn btn-primary btn-compact" type="button" data-preview-technical-material="${escapeAttr(material.id)}">${previewLabel}</button><a class="btn btn-outline btn-compact" href="${escapeAttr(driveUrl)}" target="_blank" rel="noopener noreferrer">Open in Drive ↗</a>`
      : driveUrl
        ? `<a class="btn btn-primary btn-compact" href="${escapeAttr(driveUrl)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>`
    : `<span class="technical-material-unavailable">This resource link is unavailable.</span>`;
  return `<article class="technical-material-card">
    <div class="technical-material-card-top"><span class="technical-material-icon">${materialIcon(technicalMaterialKindIcon(material.kind))}</span><span class="technical-material-kind">${escapeHtml(label)}</span></div>
    <h3>${escapeHtml(material.title || "Technical material")}</h3>
    <p>${escapeHtml(material.description || "Open this Google Drive resource for the full material.")}</p>
    <div class="technical-material-actions">${resourceActions}${adminAction}</div>
  </article>`;
}

function renderTechnicalMaterials(items = state.technicalMaterials) {
  if (refs.technicalMaterialsCount) {
    const count = items.length;
    refs.technicalMaterialsCount.textContent = `${count} ${count === 1 ? "material" : "materials"}`;
  }
  if (refs.technicalMaterialsGrid) {
    refs.technicalMaterialsGrid.innerHTML = items.length
      ? items.map(technicalMaterialCardMarkup).join("")
      : `<div class="empty-state">No technical materials yet. An admin can add the team’s first resource.</div>`;
  }
  if ($("addTechnicalMaterialBtn")) $("addTechnicalMaterialBtn").classList.toggle("hidden", !canManageTechnicalMaterials());
}

async function loadTechnicalMaterials() {
  if (!refs.technicalMaterialsGrid) return;
  if (!canReadTechnicalMaterials()) {
    state.technicalMaterials = [];
    renderTechnicalMaterials([]);
    return;
  }
  try {
    const snapshot = await getDocs(query(collection(db, "technicalMaterials"), orderBy("createdAt", "desc")));
    state.technicalMaterials = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderTechnicalMaterials(state.technicalMaterials);
  } catch (error) {
    state.technicalMaterials = [];
    if (refs.technicalMaterialsGrid) refs.technicalMaterialsGrid.innerHTML = `<div class="empty-state">Technical materials could not be loaded. Check the Firestore rules and sign-in role.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function openRequestedTechnicalMaterial() {
  if (page !== "admin" || !canReadTechnicalMaterials()) return;
  const url = new URL(window.location.href);
  const materialId = url.searchParams.get("technicalMaterial");
  if (!materialId) return;
  const material = state.technicalMaterials.find((item) => item.id === materialId);
  if (!material) return;
  state.activeDashboardRole = "tech";
  state.activeDashboardSection = "technical-materials";
  renderDashboard();
  openTechnicalMaterialPreview(material);
  url.searchParams.delete("technicalMaterial");
  window.history.replaceState({}, "", url);
}

function openTechnicalMaterialEditor() {
  if (!canManageTechnicalMaterials()) return showToast("You do not have permission to manage Technical materials.", "error");
  $("technicalMaterialForm")?.reset();
  if ($("technicalMaterialId")) $("technicalMaterialId").value = "";
  if ($("technicalMaterialCurrentFile")) $("technicalMaterialCurrentFile").textContent = "Choose a private upload or enter an existing link.";
  if ($("technicalMaterialProgress")) { $("technicalMaterialProgress").hidden = true; $("technicalMaterialProgress").value = 0; }
  if ($("technicalMaterialModalTitle")) $("technicalMaterialModalTitle").textContent = "Add Technical material";
  if ($("saveTechnicalMaterialBtn")) $("saveTechnicalMaterialBtn").textContent = "Add to Technical materials";
  openModal("technicalMaterialModal");
  $("technicalMaterialTitle")?.focus();
}

function openTechnicalMaterialEdit(id) {
  if (!canManageTechnicalMaterials()) return showToast("You do not have permission to manage Technical materials.", "error");
  const material = state.technicalMaterials.find((item) => item.id === id);
  if (!material) return;
  $("technicalMaterialForm")?.reset();
  $("technicalMaterialId").value = material.id;
  $("technicalMaterialTitle").value = material.title || "";
  $("technicalMaterialKind").value = material.kind || "material";
  $("technicalMaterialUrl").value = material.url || "";
  $("technicalMaterialDescription").value = material.description || "";
  $("technicalMaterialFile").value = "";
  $("technicalMaterialCurrentFile").textContent = material.driveFileName
    ? `Current private Drive file: ${material.driveFileName}. Choose a new file to replace it.`
    : "Choose a private upload or keep the existing link.";
  if ($("technicalMaterialProgress")) { $("technicalMaterialProgress").hidden = true; $("technicalMaterialProgress").value = 0; }
  $("technicalMaterialModalTitle").textContent = "Edit Technical material";
  $("saveTechnicalMaterialBtn").textContent = "Save changes";
  openModal("technicalMaterialModal");
}

function openTechnicalMaterialPreview(material) {
  if (material?.driveFileId) {
    void openDrivePreview("technicalMaterial", material.id, material.driveFileId, material.title, material.driveMimeType || "");
    return;
  }
  const driveUrl = normalizeGoogleDriveMaterialUrl(material?.url);
  const previewUrl = driveUrl ? googleDrivePreviewUrl(driveUrl) : "";
  if (!previewUrl) return showToast("This Drive link cannot be previewed. Open the original link instead.", "error");
  $("technicalMaterialPreviewKind").textContent = technicalMaterialKindLabel(material.kind);
  $("technicalMaterialPreviewTitle").textContent = material.title || "Technical material";
  $("technicalMaterialPreviewFrame").title = `${material.title || "Technical material"} preview`;
  $("technicalMaterialPreviewFrame").src = previewUrl;
  $("technicalMaterialOpenLink").href = material.url;
  $("technicalMaterialInlinePreview").classList.remove("hidden");
  $("technicalMaterialInlinePreview").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeTechnicalMaterialPreview() {
  $("technicalMaterialInlinePreview")?.classList.add("hidden");
  if ($("technicalMaterialPreviewFrame")) $("technicalMaterialPreviewFrame").src = "";
}

async function handleTechnicalMaterialsClick(event) {
  const editButton = event.target.closest("[data-edit-technical-material]");
  if (editButton) {
    openTechnicalMaterialEdit(editButton.dataset.editTechnicalMaterial);
    return;
  }
  const previewButton = event.target.closest("[data-preview-technical-material]");
  if (previewButton) {
    const material = state.technicalMaterials.find((item) => item.id === previewButton.dataset.previewTechnicalMaterial);
    if (material) openTechnicalMaterialPreview(material);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-technical-material]");
  if (!deleteButton) return;
  if (!canManageTechnicalMaterials()) return showToast("You do not have permission to manage Technical materials.", "error");
  const material = state.technicalMaterials.find((item) => item.id === deleteButton.dataset.deleteTechnicalMaterial);
  if (!material || !window.confirm(`Delete “${material.title}” from Technical materials?`)) return;
  try {
    await deleteDoc(doc(db, "technicalMaterials", material.id));
    state.technicalMaterials = state.technicalMaterials.filter((item) => item.id !== material.id);
    renderTechnicalMaterials(state.technicalMaterials);
    showToast("Technical material deleted.");
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function saveTechnicalMaterial(event) {
  event.preventDefault();
  if (!canManageTechnicalMaterials()) return showToast("You do not have permission to manage Technical materials.", "error");
  const title = $("technicalMaterialTitle").value.trim();
  const kind = $("technicalMaterialKind").value;
  const description = $("technicalMaterialDescription").value.trim();
  const url = normalizeGoogleDriveMaterialUrl($("technicalMaterialUrl").value.trim());
  const file = $("technicalMaterialFile")?.files?.[0] || null;
  const existing = state.technicalMaterials.find((item) => item.id === $("technicalMaterialId")?.value);
  if (!title) return showToast("Enter a title for this resource.", "error");
  if (!["video", "lecture", "book", "material"].includes(kind)) return showToast("Choose a valid resource type.", "error");
  if ($("technicalMaterialUrl").value.trim() && !url) return showToast("Enter a valid Google Drive or Google Docs HTTPS sharing link.", "error");
  if (!url && !file && !existing?.driveFileId) return showToast("Add an existing Drive link or choose a file to upload.", "error");
  const button = $("saveTechnicalMaterialBtn");
  const materialId = $("technicalMaterialId")?.value || "";
  const materialRef = materialId ? doc(db, "technicalMaterials", materialId) : doc(collection(db, "technicalMaterials"));
  const progress = $("technicalMaterialProgress");
  if (button) {
    button.disabled = true;
    button.textContent = materialId ? "Saving…" : "Adding…";
  }
  try {
    let notificationError = null;
    let driveFields = file ? null : {
      driveFileId: url ? "" : existing?.driveFileId || "",
      driveFileName: url ? "" : existing?.driveFileName || "",
      driveMimeType: url ? "" : existing?.driveMimeType || "",
      driveSizeBytes: url ? 0 : Number(existing?.driveSizeBytes) || 0,
      driveUploadedByUid: url ? "" : existing?.driveUploadedByUid || "",
      driveUploadedAt: url ? "" : existing?.driveUploadedAt || ""
    };
    if (file) {
      if (progress) { progress.hidden = false; progress.value = 0; }
      const uploaded = await uploadDriveFile(auth, file, {
        category: "technicalMaterial", targetRole: "tech",
        sourceId: materialRef.id, sizeBytes: file.size
      }, {
        onProgress: (percent) => { if (progress) progress.value = percent; }
      });
      driveFields = {
        driveFileId: uploaded.id,
        driveFileName: uploaded.fileName,
        driveMimeType: uploaded.mimeType,
        driveSizeBytes: uploaded.sizeBytes,
        driveUploadedByUid: state.user.uid,
        driveUploadedAt: uploaded.uploadedAt || new Date().toISOString()
      };
    }
    const common = { title, kind, description, url: file ? "" : url, ...driveFields };
    if (materialId) {
      await updateDoc(materialRef, {
        ...common, updatedAt: serverTimestamp(), updatedByUid: state.user.uid
      });
      try {
        await notifyTechnicalTeamOfMaterial(materialId, { title, kind, description, driveFileId: driveFields.driveFileId }, true);
      } catch (error) {
        notificationError = error;
      }
    } else {
      await setDoc(materialRef, {
        ...common,
        createdAt: serverTimestamp(),
        createdByUid: state.user.uid,
        createdByName: memberDisplayName(state.member, state.user).slice(0, 80)
      });
      try {
        await notifyTechnicalTeamOfMaterial(materialRef.id, { title, kind, description, driveFileId: driveFields.driveFileId });
      } catch (error) {
        notificationError = error;
      }
    }
    if (progress) progress.hidden = true;
    closeModal("technicalMaterialModal");
    $("technicalMaterialForm").reset();
    if ($("technicalMaterialId")) $("technicalMaterialId").value = "";
    showToast(materialId
      ? notificationError
        ? `Technical material updated, but the Technical team inbox could not be notified: ${firebaseError(notificationError)}`
        : "Technical material updated and the Technical team was notified."
      : notificationError
        ? `Technical material added, but the Technical team inbox could not be notified: ${firebaseError(notificationError)}`
        : "Technical material added and the Technical team has been notified.", notificationError ? "error" : "ok");
    await loadTechnicalMaterials();
  } catch (error) {
    showToast(firebaseError(error), "error");
  } finally {
    if (progress) progress.hidden = true;
    if (button) {
      button.disabled = false;
      button.textContent = $("technicalMaterialId")?.value ? "Save changes" : "Add to Technical materials";
    }
  }
}

async function notifyTechnicalTeamOfMaterial(materialId, material, updated = false) {
  const [memberSnapshot, grantSnapshot] = await Promise.all([
    getDocs(query(collection(db, "teamMembers"), where("active", "==", true))),
    getDocs(query(collection(db, "dashboardAccessGrants"),
      where("capability", "in", ["technicalMaterialsRead", "technicalMaterialsManage"]),
      where("active", "==", true)))
  ]);
  const grants = grantSnapshot.docs.map((item) => ({ ...item.data(), id: item.id }));
  const recipients = memberSnapshot.docs.map((item) => ({ ...item.data(), uid: item.id })).filter((member) => {
    if (member.active !== true) return false;
    if (member.role === "tech" || (Array.isArray(member.teamLeadRoles) && member.teamLeadRoles.includes("tech"))) return true;
    if (member.role === "admin" && adminTeamAssignment(member)?.role === "tech") return true;
    return grants.some((grant) => grant.active === true
      && ["technicalMaterialsRead", "technicalMaterialsManage"].includes(grant.capability)
      && ((grant.scopeType === "user" && grant.scopeTarget === member.uid)
        || (grant.scopeType === "role" && grant.scopeTarget === member.role)
        || (grant.scopeType === "university" && grant.scopeTarget === member.universityTag)));
  });
  if (!recipients.length) return 0;
  const kindLabel = technicalMaterialKindLabel(material.kind).toLowerCase();
  const notificationTitle = `${updated ? "Updated" : "New"} Technical material: ${material.title}`.slice(0, 120);
  const notificationMessage = `${updated ? `A ${kindLabel} in Technical materials was updated.` : `A new ${kindLabel} was added to Technical materials.`}${material.description ? ` ${material.description}` : ""}`.slice(0, 1500);
  return notifyInboxMembers(recipients, "technical_material", notificationTitle, notificationMessage, (member) => {
    const grant = grants.find((item) =>
      (item.scopeType === "user" && item.scopeTarget === member.uid)
      || (item.scopeType === "role" && item.scopeTarget === member.role)
      || (item.scopeType === "university" && item.scopeTarget === member.universityTag));
    return {
      technicalMaterialId: materialId,
      ...(member.role !== "tech" && grant ? { technicalAccessGrantId: grant.id } : {})
    };
  }, 1);
}

function roleResourceKindLabel(kind) {
  return ({ link: "Link", video: "Video", book: "Book", document: "Document", tool: "Tool", inspiration: "Inspiration" })[kind] || "Link";
}

function roleResourceKindIcon(kind) {
  return ({ link: "link", video: "play_circle", book: "menu_book", document: "description", tool: "build", inspiration: "auto_awesome" })[kind] || "open_in_new";
}

function roleResourceCardMarkup(resource) {
  const url = normalizeHttpUrl(resource.url);
  const sharedRoleTag = resource.targetRole === "leaders" && state.activeDashboardRole !== "leaders"
    ? `<span class="role-resource-shared-badge">Leaders role library</span>`
    : "";
  const managerActions = canManageRoleResources(resource.targetRole)
    ? `<button class="btn btn-outline btn-compact" type="button" data-edit-role-resource="${escapeAttr(resource.id)}">Edit</button><button class="btn btn-danger btn-compact" type="button" data-delete-role-resource="${escapeAttr(resource.id)}">Delete</button>`
    : "";
  return `<article class="role-resource-card">
    <div class="role-resource-card-icon">${materialIcon(roleResourceKindIcon(resource.kind))}</div>
    <div class="role-resource-copy">${sharedRoleTag}<span class="role-resource-kind">${escapeHtml(roleResourceKindLabel(resource.kind))}</span><h3>${escapeHtml(resource.title || "Team resource")}</h3><p>${escapeHtml(resource.description || "Shared with your team.")}</p></div>
    <div class="role-resource-actions">${resource.driveFileId
      ? `<button class="btn btn-primary btn-compact" type="button" data-preview-role-resource="${escapeAttr(resource.id)}">Preview ${materialIcon("visibility")}</button>`
      : url ? `${googleDrivePreviewUrl(url) ? `<button class="btn btn-primary btn-compact" type="button" data-preview-role-link="${escapeAttr(resource.id)}">Preview ${materialIcon("visibility")}</button>` : ""}<a class="btn btn-outline btn-compact" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open resource ${materialIcon("open_in_new")}</a>`
        : `<span class="technical-material-unavailable">This resource is unavailable.</span>`}${managerActions}</div>
  </article>`;
}

function renderRoleResources(items = state.roleResources) {
  const roleKey = state.activeDashboardRole;
  if (!refs.roleResourcesGrid) return;
  const roleName = ROLE_CONFIG[roleKey]?.label || "Team";
  const includeLeadersLibrary = roleKey !== "leaders" && isPositionLeader(state.member);
  if ($("roleResourcesTitle")) $("roleResourcesTitle").textContent = `Resources for ${roleName}${includeLeadersLibrary ? " + Leaders" : ""}`;
  if ($("roleResourcesKicker")) $("roleResourcesKicker").textContent = includeLeadersLibrary
    ? `${roleName} and Leaders resource libraries`
    : `${roleName} resource library`;
  if ($("roleResourcesHint")) $("roleResourcesHint").textContent = canManageRoleResources(roleKey)
    ? includeLeadersLibrary
      ? "Manage your team resources. Leaders-role resources are also shown here for position leaders."
      : "Manage the links and materials your team uses. Members can open the resources here."
    : includeLeadersLibrary
      ? "Your team resources and the Leaders account-role library are available here."
    : "Shared links and learning materials selected for your team.";
  if (refs.roleResourcesCount) refs.roleResourcesCount.textContent = `${items.length} ${items.length === 1 ? "resource" : "resources"}`;
  if ($("addRoleResourceBtn")) $("addRoleResourceBtn").classList.toggle("hidden", !canManageRoleResources(roleKey));
  const permissionNote = state.roleResourceLoadWarning
    ? `<div class="role-resource-permission-note" role="status">${escapeHtml(state.roleResourceLoadWarning)}</div>`
    : "";
  refs.roleResourcesGrid.innerHTML = `${permissionNote}${items.length
    ? items.map(roleResourceCardMarkup).join("")
    : `<div class="empty-state">${canManageRoleResources(roleKey) ? "No resources yet. Add the first link for this team." : "No resources have been shared with this team yet."}</div>`}`;
}

async function loadRoleResources(roleKey = state.activeDashboardRole) {
  if (!refs.roleResourcesGrid) return;
  if (!canReadRoleResources(roleKey)) {
    state.roleResources = [];
    state.roleResourceLoadWarning = "";
    renderRoleResources([]);
    return;
  }
  state.roleResourceLoadWarning = "";
  refs.roleResourcesGrid.innerHTML = `<div class="empty-state">Loading ${escapeHtml(ROLE_CONFIG[roleKey]?.label || "team")} resources…</div>`;
  try {
    const resourceRoles = roleKey !== "leaders" && isPositionLeader(state.member)
      ? [roleKey, "leaders"]
      : [roleKey];
    const results = await Promise.allSettled(resourceRoles.map((resourceRole) =>
      getDocs(query(collection(db, "roleResources"), where("targetRole", "==", resourceRole)))));
    if (state.activeDashboardRole !== roleKey) return;
    if (results[0].status === "rejected") throw results[0].reason;
    const snapshots = results.map((result) => result.status === "fulfilled" ? result.value : null);
    if (resourceRoles.includes("leaders") && results[resourceRoles.indexOf("leaders")].status === "rejected") {
      state.roleResourceLoadWarning = "Leaders resources were blocked by Firestore permissions. Publish the latest firestore.rules and confirm this member still has a position-leader role assigned.";
    }
    const combined = [];
    resourceRoles.forEach((resourceRole, index) => {
      if (!snapshots[index]) return;
      const stored = new Map(snapshots[index].docs.map((item) => [item.id, { id: item.id, ...item.data() }]));
      const defaults = (DEFAULT_ROLE_RESOURCES[resourceRole] || []).flatMap((starter) => {
        const override = stored.get(starter.id);
        if (override?.active === false) return [];
        stored.delete(starter.id);
        return [{ ...starter, ...(override || {}), id: starter.id, targetRole: resourceRole, active: true, storedInFirestore: Boolean(override) }];
      });
      const custom = [...stored.values()].filter((item) => item.active !== false)
        .map((item) => ({ ...item, storedInFirestore: true }));
      combined.push(...defaults, ...custom);
    });
    state.roleResources = combined.sort((a, b) => {
      const aDate = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
      const bDate = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
      return bDate - aDate || String(a.title || "").localeCompare(String(b.title || ""));
    });
    renderRoleResources(state.roleResources);
  } catch (error) {
    if (state.activeDashboardRole !== roleKey) return;
    state.roleResources = [];
    state.roleResourceLoadWarning = "";
    refs.roleResourcesGrid.innerHTML = `<div class="empty-state">Team resources could not be loaded. Check the deployed Firestore rules.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function openRoleResourceEditor(resource = null) {
  const activeRole = state.activeDashboardRole;
  if (!canManageRoleResources(activeRole)) return showToast("Resource management access is required.", "error");
  const form = $("roleResourceForm");
  if (!form) return;
  form.reset();
  const target = $("roleResourceTargetRole");
  const roles = ASSIGNABLE_DASHBOARD_ROLES.filter(canManageRoleResources);
  target.innerHTML = roles.map((roleKey) => `<option value="${escapeAttr(roleKey)}">${escapeHtml(ROLE_CONFIG[roleKey].label)}</option>`).join("");
  target.disabled = Boolean(resource);
  target.value = resource?.targetRole || (roles.includes(activeRole) ? activeRole : roles[0] || "");
  $("roleResourceId").value = resource?.id || "";
  $("roleResourceStored").value = resource?.storedInFirestore ? "true" : "false";
  $("roleResourceTitle").value = resource?.title || "";
  $("roleResourceUrl").value = resource?.url || "";
  $("roleResourceDescription").value = resource?.description || "";
  $("roleResourceKind").value = resource?.kind || "link";
  $("roleResourceFile").value = "";
  $("roleResourceCurrentFile").textContent = resource?.driveFileName
    ? `Current private Drive file: ${resource.driveFileName}. Choose a new file to replace it.`
    : "Choose a private upload or enter an existing link.";
  if ($("roleResourceProgress")) { $("roleResourceProgress").hidden = true; $("roleResourceProgress").value = 0; }
  $("roleResourceModalTitle").textContent = resource ? "Edit team resource" : "Add team resource";
  $("saveRoleResourceBtn").textContent = resource ? "Save changes" : "Add resource";
  $("roleResourcePermissionHint").textContent = "Shared with the selected team and members granted access to its library.";
  openModal("roleResourceModal");
  $("roleResourceTitle")?.focus();
}

async function notifyRoleResourceAudience(resourceId, resource, updated = false) {
  const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
  const recipients = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() })).filter((member) => {
    if (member.role === resource.targetRole
      || (Array.isArray(member.teamLeadRoles) && member.teamLeadRoles.includes(resource.targetRole))
      || (Array.isArray(member.dashboardRoles) && member.dashboardRoles.includes(resource.targetRole))
      || (member.role === "admin" && adminTeamAssignment(member)?.role === resource.targetRole)
      || (resource.targetRole === "leaders" && isPositionLeader(member))) return true;
    return false;
  });
  const notificationKey = `role-resource_${resourceId}_${Date.now()}`;
  return notifyInboxMembers(
    recipients,
    "role_resource",
    `${updated ? "Updated" : "New"} ${ROLE_CONFIG[resource.targetRole]?.label || "team"} resource: ${resource.title}`,
    updated ? `${resource.title} was updated in your team resources.` : `${resource.title} was added to your team resources.`,
    { roleResourceId: resourceId, roleResourceRole: resource.targetRole },
    3,
    notificationKey
  );
}

async function saveRoleResource(event) {
  event.preventDefault();
  const id = $("roleResourceId")?.value || "";
  const targetRole = $("roleResourceTargetRole")?.value || "";
  if (!canManageRoleResources(targetRole)) return showToast("You can only manage resources for a team you lead.", "error");
  const title = $("roleResourceTitle")?.value.trim() || "";
  const description = $("roleResourceDescription")?.value.trim() || "";
  const url = normalizeHttpUrl($("roleResourceUrl")?.value.trim());
  const file = $("roleResourceFile")?.files?.[0] || null;
  const kind = $("roleResourceKind")?.value || "";
  if (title.length < 1 || title.length > 120) return showToast("Use a resource title up to 120 characters.", "error");
  const currentResource = id ? state.roleResources.find((item) => item.id === id) : null;
  if (!url && !file && !currentResource?.driveFileId) return showToast("Add an existing link or choose a private file to upload.", "error");
  if (url && new URL(url).protocol !== "https:") return showToast("Enter a valid HTTPS link.", "error");
  if (description.length > 600) return showToast("Keep the description under 600 characters.", "error");
  if (!["link", "video", "book", "document", "tool", "inspiration"].includes(kind)) return showToast("Choose a valid resource type.", "error");
  const button = $("saveRoleResourceBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Saving…";
  }
  try {
    const resourceRef = id ? doc(db, "roleResources", id) : doc(collection(db, "roleResources"));
    const hasStoredResource = $("roleResourceStored")?.value === "true";
    const existing = id && hasStoredResource ? await getDoc(resourceRef) : null;
    const oldData = existing?.exists() ? existing.data() : null;
    if (oldData && !canManageRoleResources(oldData.targetRole)) {
      throw new Error("You do not manage the team this resource currently belongs to.");
    }
    let driveFields = file ? null : {
      driveFileId: url ? "" : oldData?.driveFileId || "",
      driveFileName: url ? "" : oldData?.driveFileName || "",
      driveMimeType: url ? "" : oldData?.driveMimeType || "",
      driveSizeBytes: url ? 0 : Number(oldData?.driveSizeBytes) || 0,
      driveUploadedByUid: url ? "" : oldData?.driveUploadedByUid || "",
      driveUploadedAt: url ? "" : oldData?.driveUploadedAt || ""
    };
    const progress = $("roleResourceProgress");
    if (file) {
      if (progress) { progress.hidden = false; progress.value = 0; }
      const uploaded = await uploadDriveFile(auth, file, {
        category: "roleResource", targetRole,
        sourceId: resourceRef.id, sizeBytes: file.size
      }, {
        onProgress: (percent) => { if (progress) progress.value = percent; }
      });
      driveFields = {
        driveFileId: uploaded.id,
        driveFileName: uploaded.fileName,
        driveMimeType: uploaded.mimeType,
        driveSizeBytes: uploaded.sizeBytes,
        driveUploadedByUid: state.user.uid,
        driveUploadedAt: uploaded.uploadedAt || new Date().toISOString()
      };
    }
    const data = {
      targetRole, title, description, url: file ? "" : url, kind, active: true, ...driveFields,
      createdByUid: oldData?.createdByUid || state.user.uid,
      createdAt: oldData?.createdAt || serverTimestamp(),
      updatedByUid: state.user.uid, updatedAt: serverTimestamp()
    };
    await setDoc(resourceRef, data);
    let notificationError = null;
    try {
      await notifyRoleResourceAudience(resourceRef.id, data, Boolean(oldData));
    } catch (error) { notificationError = error; }
    closeModal("roleResourceModal");
    showToast(notificationError
      ? `Resource saved, but the team inbox could not be notified: ${firebaseError(notificationError)}`
      : oldData ? "Resource updated and the team was notified." : "Resource added and the team was notified.",
    notificationError ? "error" : "ok");
    await loadRoleResources(targetRole);
  } catch (error) {
    showToast(firebaseError(error), "error");
  } finally {
    if ($("roleResourceProgress")) $("roleResourceProgress").hidden = true;
    if (button) {
      button.disabled = false;
      button.textContent = id ? "Save changes" : "Add resource";
    }
  }
}

async function handleRoleResourcesClick(event) {
  const previewButton = event.target.closest("[data-preview-role-resource]");
  if (previewButton) {
    const resource = state.roleResources.find((item) => item.id === previewButton.dataset.previewRoleResource);
    if (resource?.driveFileId) {
      void openDrivePreview("roleResource", resource.id, resource.driveFileId, resource.title, resource.driveMimeType || "");
    }
    return;
  }
  const linkPreviewButton = event.target.closest("[data-preview-role-link]");
  if (linkPreviewButton) {
    const resource = state.roleResources.find((item) => item.id === linkPreviewButton.dataset.previewRoleLink);
    if (resource?.url) openLegacyDrivePreview(resource.url, resource.title);
    return;
  }
  const editButton = event.target.closest("[data-edit-role-resource]");
  if (editButton) {
    const resource = state.roleResources.find((item) => item.id === editButton.dataset.editRoleResource);
    if (resource) openRoleResourceEditor(resource);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-role-resource]");
  if (!deleteButton) return;
  const resource = state.roleResources.find((item) => item.id === deleteButton.dataset.deleteRoleResource);
  if (!resource || !canManageRoleResources(resource.targetRole)) return showToast("You do not have permission to delete this resource.", "error");
  if (!window.confirm(`Remove “${resource.title}” from ${ROLE_CONFIG[resource.targetRole]?.label || "the team"} resources?`)) return;
  try {
    if (resource.id.startsWith("starter-")) {
      if (resource.storedInFirestore) {
        await updateDoc(doc(db, "roleResources", resource.id), { active: false, updatedByUid: state.user.uid, updatedAt: serverTimestamp() });
      } else {
        await setDoc(doc(db, "roleResources", resource.id), {
          targetRole: resource.targetRole, title: resource.title, description: resource.description || "",
          url: resource.url, kind: resource.kind || "link", active: false,
          createdByUid: state.user.uid, createdAt: serverTimestamp(),
          updatedByUid: state.user.uid, updatedAt: serverTimestamp()
        });
      }
    } else {
      await deleteDoc(doc(db, "roleResources", resource.id));
    }
    showToast("Resource removed from the team library.");
    await loadRoleResources(resource.targetRole);
  } catch (error) {
    showToast(firebaseError(error), "error");
  }
}

async function loadSessionLibrary() {
  const root = $("sessionLibraryList");
  if (!root || !hasDashboardAccess("sessionsRead")) return;
  try {
    const base = collection(db, "nawrasOnlineSessions");
    const snapshots = await Promise.all(sessionQueriesForMember(base, state.member).map((ref) => getDocs(ref)));
    const sessions = mergeMemberSessions(snapshots, state.member).sort((a, b) => sortTimestampDesc(a.startsAt, b.startsAt));
    root.innerHTML = sessions.length ? sessions.map((session) => `<article class="session-library-card"><div><strong>${escapeHtml(session.title || "Session")}</strong><p>${escapeHtml(formatDate(session.startsAt))} · ${escapeHtml(session.status || "scheduled")}</p></div><a class="btn btn-outline btn-compact" href="nawras-online.html?session=${encodeURIComponent(session.id)}">Open</a></article>`).join("") : `<div class="empty-state">No sessions yet.</div>`;
  } catch (error) {
    root.innerHTML = `<div class="empty-state">Sessions could not be loaded.</div>`;
    showToast(firebaseError(error), "error");
  }
}

function dashboardSectionsFor(roleKey) {
  const sections = [
    { id: "overview", label: "Overview", icon: "dashboard", group: "Workspace", panels: ["overview"] },
    { id: "calendar", label: "My calendar", icon: "calendar_month", group: "Workspace", panels: ["calendar"] },
    { id: "my-courses", label: "My courses", icon: "menu_book", group: "Workspace", panels: ["assigned-courses"] },
    { id: "tasks", label: "Tasks", icon: "task_alt", group: "Workspace", panels: ["tasks"] },
    { id: "ask-founder", label: "Ask Founder", icon: "support_agent", group: "Workspace", panels: ["founder"] },
    { id: "cross-team-work", label: "Cross-Team Work", icon: "conversion_path", group: "Workspace", panels: ["cross-team-work"] },
    { id: "questions", label: "Questions", icon: "contact_support", group: "Workspace", panels: ["questions"] },
    { id: "inbox", label: "My inbox", icon: "inbox", group: "Workspace", panels: ["inbox"] },
    { id: "my-ratings", label: "My rating sheet", icon: "fact_check", group: "Workspace", panels: ["my-ratings"] },
    { id: "leaderboard", label: "Leaderboard", icon: "leaderboard", group: "Workspace", panels: ["leaderboard"] },
    { id: "profile", label: "My profile", icon: "account_circle", group: "Workspace", panels: ["profile"] }
  ];
  if (state.role !== "admin") sections.splice(2, 0, { id: "my-forms", label: "Assigned forms", icon: "assignment", group: "Workspace", panels: ["member-forms"] });
  if (state.role !== "admin") sections.splice(2, 0, { id: "chat", label: "Leader chat", icon: "forum", group: "Workspace", panels: ["chat"] });
  if (canReadTechnicalMaterials()) {
    sections.splice(2, 0, { id: "technical-materials", label: "Technical materials", icon: "school", group: "Workspace", panels: ["technical-materials"] });
  }
  if (state.role === "admin" && roleKey === "admin") {
    sections.push({ id: "dashboard-access", label: "Dashboard access", icon: "admin_panel_settings", group: "Administration", panels: ["dashboard-access"] });
  }
  if (canReadAllTeam()) {
    sections.push({ id: "team-members", label: "Team members", icon: "groups", group: "Team", panels: ["team-members"] });
  }
  if (canReadAttendance()) {
    sections.push({ id: "attendance", label: "Attendance", icon: "event_available", group: "Administration", panels: ["attendance"] });
  }
  if (hasDashboardAccess("sessionsRead")) {
    sections.push({ id: "sessions", label: "Sessions", icon: "video_call", group: "Dashboard tools", panels: ["sessions"] });
  }
  if (canReadAllRatings() || hasDashboardAccess("xpReset") || (state.role === "leaders" && roleKey === "leaders")) {
    sections.push({ id: "ratings", label: "Ratings sheet", icon: "fact_check", group: "Workspace", panels: ["ratings"] });
  }
  if (state.role !== "admin" && currentTeamLeadRoles().includes(roleKey)) {
    if (!canReadAllTeam()) sections.push({ id: "managed-team", label: "Managed team", icon: "groups", group: "Team leadership", panels: ["team-members"] });
    if (!canReadAllRatings()) sections.push({ id: "managed-ratings", label: "Team rating sheets", icon: "fact_check", group: "Team leadership", panels: ["ratings"] });
  }
  if (canReadCourses()) {
    sections.push({ id: "courses", label: canManageCourses() ? "Manage courses" : "Course library", icon: "library_books", group: "Dashboard tools", panels: ["courses"] });
  }
  if (canReadManagedForms()) {
    sections.push({ id: "forms", label: canManageForms() ? "Manage forms" : "View forms", icon: "description", group: "Dashboard tools", panels: ["forms"] });
  }
  if (canReadFormResponses()) {
    sections.push({ id: "responses", label: "Form submissions", icon: "rule", group: "Dashboard tools", panels: ["responses"] });
  }
  if (canReadRoleResources(roleKey)) {
    sections.push({ id: "resources", label: roleKey === "designers" ? "Design resources" : "Team resources", icon: "folder_open", group: "Resources", panels: ["role-resources"] });
  }
  return sections;
}

function dashboardRolesForMember() {
  if (state.role === "admin") return ROLE_ORDER;
  const assignedDashboards = state.role === "user" && Array.isArray(state.member?.dashboardRoles)
    ? state.member.dashboardRoles.filter((roleKey) => ASSIGNABLE_DASHBOARD_ROLES.includes(roleKey))
    : [];
  const baseRole = ROLE_CONFIG[state.role] ? [state.role] : ["user"];
  const grantedResources = ASSIGNABLE_DASHBOARD_ROLES.filter((roleKey) => hasDashboardAccess(resourceCapability(roleKey)));
  return [...new Set([...baseRole, ...assignedDashboards, ...currentTeamLeadRoles(), ...grantedResources])]
    .filter((roleKey) => ASSIGNABLE_DASHBOARD_ROLES.includes(roleKey));
}

function renderDashboard() {
  const teamHint = document.querySelector("#teamMembersPanel .panel-heading .panel-hint");
  if (teamHint) teamHint.textContent = "Members, assignments and XP.";
  const ratingsHint = document.querySelector("#ratingsPanel .panel-heading .panel-hint");
  if (ratingsHint) ratingsHint.textContent = "Choose a member to view or edit their ratings.";
  const visibleRoles = dashboardRolesForMember();
  if (!visibleRoles.includes(state.activeDashboardRole)) {
    state.activeDashboardRole = visibleRoles[0] || state.role || "user";
  }
  const themeRole = state.activeDashboardRole || state.role;
  if (refs.dashboard) refs.dashboard.dataset.roleTheme = ROLE_ART[themeRole] ? themeRole : "public";
  // Keep the dashboard header compact; the overview carries the useful content.
  const role = ROLE_CONFIG[state.activeDashboardRole || state.role] || ROLE_CONFIG.public;
  const isRoleLeader = isRoleLeaderForDashboard(state.activeDashboardRole);
  if ($("dashboardEyebrow")) $("dashboardEyebrow").textContent = isRoleLeader
    ? `NAWRAS EDU · ${role.label.toUpperCase()} POSITION LEADER`
    : `NAWRAS EDU · ${role.eyebrow}`;
  if ($("dashboardTitle")) $("dashboardTitle").textContent = `${role.label}${isRoleLeader ? " position leader" : state.activeDashboardRole === "leaders" ? " role" : ""} dashboard`;
  if ($("teamWelcome")) $("teamWelcome").textContent = `${memberDisplayName(state.member, state.user)} · Account role: ${ROLE_CONFIG[state.role]?.label || state.role}${isRoleLeader ? ` · Position: ${role.label} leader` : ""}${state.member?.universityTag ? ` · ${universityLabel(state.member.universityTag)}` : ""}`;
  if ($("addCourseBtn")) $("addCourseBtn").classList.toggle("hidden", !canManageCourses());
  if ($("addFormBtn")) $("addFormBtn").classList.toggle("hidden", !canManageForms());
  if ($("addTechnicalMaterialBtn")) $("addTechnicalMaterialBtn").classList.toggle("hidden", !canManageTechnicalMaterials());
  if (refs.roleWorkspace) {
    refs.roleWorkspace.innerHTML = "";
    refs.roleWorkspace.classList.add("hidden");
  }
  if (refs.roleDashboardNav) {
    refs.roleDashboardNav.classList.toggle("hidden", visibleRoles.length < 2);
    refs.roleDashboardNav.innerHTML = visibleRoles.map((roleKey) => `<button type="button" class="role-tab ${roleKey === state.activeDashboardRole ? "active" : ""}" data-dashboard-role="${roleKey}">${escapeHtml(ROLE_CONFIG[roleKey].label)}${isRoleLeaderForDashboard(roleKey) ? " · Position leader" : roleKey === "leaders" ? " · Account role" : ""}</button>`).join("");
    refs.roleDashboardNav.querySelectorAll("[data-dashboard-role]").forEach((button) => button.addEventListener("click", () => {
      state.activeDashboardRole = button.dataset.dashboardRole;
      state.activeDashboardSection = "overview";
      renderDashboard();
      refs.roleDashboardNav.querySelector(`[data-dashboard-role="${cssEscape(state.activeDashboardRole)}"]`)?.focus({ preventScroll: true });
      loadTeamQuestions();
      loadTasks();
      loadLeaderboard();
      if (canReadTechnicalMaterials()) loadTechnicalMaterials();
    }));
  }
  flattenManagementPanels();
  const sections = dashboardSectionsFor(state.activeDashboardRole);
  if (!sections.some((section) => section.id === state.activeDashboardSection)) state.activeDashboardSection = "overview";
  const activeSection = sections.find((section) => section.id === state.activeDashboardSection) || sections[0];
  if (refs.dashboardSectionNav) {
    let currentGroup = "";
    refs.dashboardSectionNav.innerHTML = sections.map((section) => {
      const groupHeading = section.group !== currentGroup
        ? `<span class="dashboard-nav-group">${escapeHtml(section.group)}</span>`
        : "";
      currentGroup = section.group;
      return `${groupHeading}<button type="button" class="dashboard-nav-item ${section.id === activeSection.id ? "active" : ""}" data-dashboard-section="${escapeAttr(section.id)}" aria-current="${section.id === activeSection.id ? "page" : "false"}"><span class="dashboard-nav-icon">${materialIcon(section.icon)}</span><span>${escapeHtml(section.label)}</span></button>`;
    }).join("");
  }
  const visiblePanelIds = new Set(activeSection.panels);
  dashboardPanelNodes().forEach((panel) => panel.classList.toggle("hidden", !visiblePanelIds.has(panel.dataset.dashboardPanel)));
  if (activeSection.id === "ask-founder") void loadFounderQuestions();
  if (activeSection.id === "cross-team-work") void crossTeamWork.load();
  const crossTeamCreateButton = $("crossTeamCreateButton");
  if (crossTeamCreateButton) crossTeamCreateButton.classList.toggle("hidden",
    !(state.role === "admin" || currentTeamLeadRoles().includes("event")));
  personalPlanner?.refreshOverview();
  setupDashboardLayout();
  if (canReadRoleResources(state.activeDashboardRole)) void loadRoleResources(state.activeDashboardRole);
}

upgradeStaticIcons();
onAuthStateChanged(auth, async (user) => {
  personalPlanner?.stop();
  personalPlanner = null;
  stopChatListeners();
  if (state.assignedCoursesUnsubscribe) state.assignedCoursesUnsubscribe();
  state.assignedCoursesUnsubscribe = null;
  state.assignedCourses = [];
  state.courseAssignments = [];
  state.memberForms = [];
  state.technicalMaterials = [];
  state.roleResources = [];
  state.dashboardCapabilities = {};
  state.dashboardGrants = [];
  if (state.inboxUnsubscribe) state.inboxUnsubscribe();
  state.inboxUnsubscribe = null;
  state.inboxMessages = [];
  state.user = user;
  state.isTeam = false;
  state.role = null;
  state.member = null;
  state.teamMembers = [];
  state.leaderboardMembers = [];
  state.tasks = [];
  state.taskSubmissions = {};
  crossTeamWork.reset();
  state.myRating = null;
  state.chatPartner = null;
  state.chatThreads = [];
  state.activeChatId = "";
  state.chatMessages = [];
  state.chatProfiles = {};
  if (page === "team") { await loadTeamDirectory(); return; }
  if (page === "profile") {
    const requestedUid = new URLSearchParams(window.location.search).get("uid") || (user && !user.isAnonymous ? user.uid : "");
    if (requestedUid) await loadProfilePage(requestedUid);
    else if ($("profilePage")) $("profilePage").innerHTML = `<div class="empty-state">Sign in to view your profile.</div>`;
    return;
  }
  if (user?.isAnonymous) {
    if (page === "ask") await loadMemberInbox(user.uid);
    await Promise.all([loadPublicCourses(), loadPublicForms()]);
    return;
  }
  if (user) {
    try {
      let member = await getDoc(doc(db, "teamMembers", user.uid));
      if (!member.exists() && registrationWaiter) {
        await registrationWaiter;
        if (auth.currentUser?.uid !== user.uid) return;
        member = await getDoc(doc(db, "teamMembers", user.uid));
      }
      const memberData = member.exists() ? member.data() : {};
      const role = String(memberData.role || "").toLowerCase().trim();
      if (!member.exists() || !ROLE_CONFIG[role] || memberData.active === false) {
        if (page === "admin") showToast("This account is not active in the NAWRAS EDU team.", "error");
        await signOut(auth);
        return;
      }
      state.isTeam = true;
      state.role = role;
      state.member = { uid: member.id, id: member.id, ...memberData };
      await loadDashboardAccess();
      const routeParams = new URLSearchParams(window.location.search);
      const availableDashboardRoles = dashboardRolesForMember();
      const requestedRole = routeParams.get("role");
      const defaultDashboardRole = role === "admin"
        ? "admin"
        : role === "leaders"
          ? "leaders"
          : currentTeamLeadRoles()[0] || (role === "user" ? (availableDashboardRoles[0] || "user") : role);
      state.activeDashboardRole = availableDashboardRoles.includes(requestedRole) ? requestedRole : defaultDashboardRole;
      const requestedSection = routeParams.get("view") === "managed-tasks" ? "tasks" : routeParams.get("view");
      state.activeDashboardSection = routeParams.get("rating") === "mine"
        ? "my-ratings"
        : (dashboardSectionsFor(state.activeDashboardRole).some((section) => section.id === requestedSection)
          ? requestedSection : "overview");
      updateProfileSummary();
      if (refs.adminLoginView) refs.adminLoginView.classList.add("hidden");
      if (refs.dashboard) refs.dashboard.classList.remove("hidden");
      if (page === "admin") {
        personalPlanner = createPersonalPlanner({
          db, member: state.member,
          getState: () => ({
            ...state,
            tasks: state.tasks.filter(canSubmitTaskAsCurrentUser),
            sections: dashboardSectionsFor(state.activeDashboardRole)
          }),
          navigate: (section) => {
            state.activeDashboardSection = section;
            renderDashboard();
            refs.dashboardSectionNav?.querySelector(`[data-dashboard-section="${cssEscape(section)}"]`)?.focus({ preventScroll: true });
          },
          toast: showToast
        });
        renderDashboard();
        await loadMyRatings();
        await loadAssignedCourses();
        await loadMemberForms();
        await loadMemberInbox(user.uid);
        await loadTeamQuestions();
        await loadTasks();
        await loadTeamMembers();
        await loadDashboardGrantAdmin();
        if (canReadAttendance()) await loadAttendanceSessions();
        await loadSessionLibrary();
        $("refreshSessionLibrary")?.addEventListener("click", loadSessionLibrary);
        await loadLeaderboard();
        await loadMemberChat();
        if (canReadCourses() || canReadManagedForms()) await loadTeamData();
        await loadTechnicalMaterials();
        openRequestedTechnicalMaterial();
        renderDashboard();
      } else {
        if (page === "ask") await loadMemberInbox(user.uid);
        await Promise.all([loadPublicCourses(), loadPublicForms()]);
      }
    } catch (error) {
      showToast(`Could not verify team access: ${error?.code || error?.message || "unknown Firebase error"}`, "error");
      if (page === "admin") {
        if (refs.adminLoginView) refs.adminLoginView.classList.remove("hidden");
        if (refs.dashboard) refs.dashboard.classList.add("hidden");
      }
    }
  } else {
    if (refs.adminLoginView) refs.adminLoginView.classList.remove("hidden");
    if (refs.dashboard) refs.dashboard.classList.add("hidden");
    await Promise.all([loadPublicCourses(), loadPublicForms()]);
  }
});

state.fieldBuilder = [newField()];
renderFieldBuilder();

/* Weekly schedule */
const DEFAULT_SESSIONS = [
  { id: "s1", name: "Leaders", tag: "Leaders", start: "17:00", end: "17:30", displayTime: "5:00 – 5:30 PM" },
  { id: "s2", name: "Public", tag: "Public", start: "18:00", end: "18:30", displayTime: "6:00 – 6:30 PM" },
  { id: "s3", name: "Technical", tag: "Technical", start: "18:30", end: "19:00", displayTime: "6:30 – 7:00 PM" },
  { id: "s4", name: "Social", tag: "Social", start: "19:00", end: "19:30", displayTime: "7:00 – 7:30 PM" },
  { id: "s5", name: "Designers", tag: "Designers", start: "19:30", end: "20:00", displayTime: "7:30 – 8:00 PM" },
  { id: "s6", name: "Content", tag: "Content", start: "20:00", end: "20:30", displayTime: "8:00 – 8:30 PM" },
  { id: "s7", name: "Event", tag: "Event", start: "20:30", end: "21:00", displayTime: "8:30 – 9:00 PM" }
];
const DAY_NAMES = { 4: "Thursday", 5: "Friday", 6: "Saturday" };

function getUpcomingMeeting() {
  const now = new Date();
  for (let offset = 0; offset <= 7; offset += 1) {
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const day = target.getDay();
    if (![4, 5, 6].includes(day)) continue;
    for (const session of (state.schedule.length ? state.schedule : DEFAULT_SESSIONS)) {
      if (!sessionOccursOnDay(session, day)) continue;
      const [startHour, startMinute] = session.start.split(":").map(Number);
      const [endHour, endMinute] = session.end.split(":").map(Number);
      const start = new Date(target.getFullYear(), target.getMonth(), target.getDate(), startHour, startMinute);
      const end = new Date(target.getFullYear(), target.getMonth(), target.getDate(), endHour, endMinute);
      if (now < end) return { session, day, dayName: DAY_NAMES[day], start, end, isLive: now >= start, isToday: offset === 0 };
    }
  }
  return null;
}

function updateLiveCalendarUI() {
  const banner = $("liveStatusBanner");
  const text = $("liveStatusText");
  const timeline = $("timelineList");
  if (!banner || !text || !timeline) return;
  const info = getUpcomingMeeting();
  if (!info) return;
  const now = new Date();
  if (info.isLive) {
    banner.classList.add("is-live");
    text.textContent = `Live now: ${info.session.name} training · ends in ${Math.ceil((info.end - now) / 60000)} min`;
  } else {
    banner.classList.remove("is-live");
    const minutes = Math.max(0, Math.floor((info.start - now) / 60000));
    const dayText = info.isToday ? "today" : `on ${info.dayName}`;
    text.textContent = `Next training: ${info.session.name} · ${dayText} at ${formatSessionTime(info.session)} · in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (!state.userSelectedDay) {
    state.selectedDay = [4, 5, 6].includes(now.getDay()) ? now.getDay() : info.day;
  }
  renderScheduleList(info);
}

function renderScheduleList(liveInfo) {
  const timeline = $("timelineList");
  if (!timeline) return;
  document.querySelectorAll(".day-tab").forEach((tab) => tab.classList.toggle("active", Number(tab.dataset.day) === state.selectedDay));
  const today = new Date().getDay() === state.selectedDay;
  const sessions = (state.schedule.length ? state.schedule : DEFAULT_SESSIONS).filter((session) => sessionOccursOnDay(session, state.selectedDay));
  timeline.innerHTML = sessions.map((session) => {
    const isCurrent = today && liveInfo?.session.id === session.id;
    const isLive = isCurrent && liveInfo.isLive;
    const isNext = isCurrent && !liveInfo.isLive && liveInfo.isToday;
    return `<div class="timeline-item ${isLive ? "is-active" : ""}${isNext ? " is-next" : ""}" data-open-session="${escapeAttr(session.id)}" role="button" tabindex="0"><div class="time-badge">${escapeHtml(formatSessionTime(session))}</div><div class="timeline-content"><div>${isLive ? `<span class="status-pill live">Live now</span>` : isNext ? `<span class="status-pill next">Next</span>` : ""}<h4>${escapeHtml(session.name)}</h4></div><span class="session-tag">${escapeHtml(session.tag)}</span></div></div>`;
  }).join("");
  timeline.querySelectorAll("[data-open-session]").forEach((item) => {
    item.addEventListener("click", () => openSessionBoard(item.dataset.openSession));
    item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openSessionBoard(item.dataset.openSession); } });
  });
}

function normalizeMiroUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "miro.com" || url.hostname.endsWith(".miro.com")) ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

function openSessionBoard(id) {
  const session = (state.schedule.length ? state.schedule : DEFAULT_SESSIONS).find((item) => item.id === id);
  if (!session || !$("sessionMiroModal")) return;
  const boardUrl = normalizeMiroUrl(session.miroUrl || "");
  $("sessionMiroTitle").textContent = session.miroTitle || `${session.name} board`;
  $("sessionMiroDescription").textContent = session.description || `Live board for the ${session.name} training session.`;
  $("sessionMiroLink").href = boardUrl || "https://miro.com/";
  $("sessionMiroLink").classList.toggle("disabled-link", !boardUrl);
  const attendUrl = primaryDomainSessionUrl(session.attendUrl || "");
  const attendLink = $("sessionAttendLink");
  const attendHint = $("sessionAttendHint");
  if (attendLink) {
    attendLink.href = attendUrl || "#";
    attendLink.classList.toggle("hidden", !attendUrl);
  }
  if (attendHint) attendHint.classList.toggle("hidden", Boolean(attendUrl));
  $("sessionMiroFrame").innerHTML = boardUrl
    ? `<iframe title="${escapeAttr(session.miroTitle || session.name)} Miro board" src="${escapeAttr(boardUrl)}" frameborder="0" scrolling="no" allow="fullscreen; clipboard-read; clipboard-write" allowfullscreen></iframe>`
    : `<div class="empty-state">A Miro board has not been connected to this session yet. The technical team can add one from the team dashboard.</div>`;
  openModal("sessionMiroModal");
}

document.querySelectorAll(".day-tab").forEach((tab) => tab.addEventListener("click", () => {
  state.selectedDay = Number(tab.dataset.day);
  state.userSelectedDay = true;
  updateLiveCalendarUI();
}));
// No public schedule listeners: personal-calendar.js owns session synchronisation.
if ($("publicQuestionsList")) loadPublicQuestions();

/* Lightweight reveal animation that also works with reduced motion and older browsers. */
const revealTargets = document.querySelectorAll("[data-reveal], [data-reveal-group]");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
  }), { threshold: 0.12 });
  revealTargets.forEach((target) => observer.observe(target));
} else {
  revealTargets.forEach((target) => target.classList.add("is-visible"));
}
