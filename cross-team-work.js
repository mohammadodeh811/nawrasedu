import {
  addDoc, collection, doc, getDoc, getDocs, query, runTransaction,
  serverTimestamp, setDoc, Timestamp, where, writeBatch
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const TEAM_ROLES = ["user", "leaders", "public", "tech", "social", "designers", "content", "event"];
const TEAM_LABELS = {
  user: "User", leaders: "Leaders", public: "Public", tech: "Technical",
  social: "Social", designers: "Designers", content: "Content", event: "Event"
};
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const MAX_STAGES = 6;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const escapeAttr = escapeHtml;
const cleanText = (value, max = 1000) => String(value || "").trim().slice(0, max);
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href.slice(0, 1000) : "";
  } catch (_) { return ""; }
};
const roleLabel = (key) => TEAM_LABELS[key] || key || "Team";
const dateInputValue = (value) => {
  const date = value?.toDate ? value.toDate() : value instanceof Date ? value : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const dateFromInput = (value) => {
  if (!value) return null;
  const date = new Date(`${value}T23:59:00`);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
};
const asDate = (value) => value?.toDate ? value.toDate() : value instanceof Date ? value : null;
const dateLabel = (value) => {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : "No deadline";
};
const relativeTime = (value) => {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Just now";
};
const stageStatusLabel = (status) => ({
  pending: "Pending", in_progress: "In progress", submitted: "Submitted for review",
  needs_revision: "Needs revision", completed: "Completed", blocked: "Blocked"
}[status] || "Pending");
const workflowStatusLabel = (status) => ({
  active: "In progress", paused: "Paused", completed: "Completed", cancelled: "Cancelled"
}[status] || status);

export function createCrossTeamWork({ db, getContext, canManage, notifyInboxMembers, toast }) {
  const panel = document.getElementById("crossTeamWorkPanel");
  if (!panel) return { load: async () => {}, refresh: () => {}, reset: () => {} };
  const listRoot = document.getElementById("crossTeamWorkflowList");
  const detailRoot = document.getElementById("crossTeamWorkflowDetail");
  const createForm = document.getElementById("crossTeamCreateForm");
  const stageRows = document.getElementById("crossTeamStageRows");
  let workflows = [];
  let selectedId = "";
  let selectedWorkflow = null;
  let selectedStages = [];
  let selectedActivity = [];
  let activeMembers = [];
  let loading = false;

  const ctx = () => getContext?.() || {};
  const uid = () => ctx().user?.uid || "";
  const isAdmin = () => ctx().role === "admin";
  const mayCreate = () => Boolean(ctx().role === "admin"
    || (Array.isArray(ctx().teamLeadRoles) && ctx().teamLeadRoles.includes("event")));
  const canManageStage = (stage) => {
    const c = ctx();
    const assigned = Array.isArray(stage?.assignedMemberUids) ? stage.assignedMemberUids : [];
    return c.role === "admin"
      || (Array.isArray(c.teamLeadRoles) && c.teamLeadRoles.includes(stage?.teamRole))
      || (c.role === stage?.teamRole && (!assigned.length || assigned.includes(c.user?.uid)));
  };
  const drivePreviewUrl = (value) => {
    try {
      const url = new URL(safeUrl(value));
      if (!["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())) return "";
      const filePath = url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)/);
      const googleDoc = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
      const openId = url.hostname === "drive.google.com" ? url.searchParams.get("id") : "";
      const id = filePath?.[1] || googleDoc?.[2] || openId;
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return "";
      if (url.hostname === "docs.google.com" && googleDoc) {
        const type = googleDoc[1];
        return type === "presentation"
          ? `https://docs.google.com/presentation/d/${id}/embed`
          : `https://docs.google.com/${type}/d/${id}/preview`;
      }
      return `https://drive.google.com/file/d/${id}/preview`;
    } catch (_) { return ""; }
  };
  const canReadWorkflow = (workflow) => {
    const c = ctx();
    const dashboardRoles = Array.isArray(c.dashboardRoles) ? c.dashboardRoles : [];
    return c.role === "admin" || workflow?.createdByUid === c.user?.uid
      || workflow?.participantRoles?.includes(c.role)
      || workflow?.participantUids?.includes(c.user?.uid)
      || workflow?.participantRoles?.some((role) => dashboardRoles.includes(role))
      || (Array.isArray(c.teamLeadRoles) && workflow?.participantRoles?.some((role) => c.teamLeadRoles.includes(role)));
  };
  const workflowRef = (id) => doc(db, "crossTeamWorkflows", id);
  const stageRef = (workflowId, stageId) => doc(db, "crossTeamWorkflows", workflowId, "stages", stageId);
  const activityRef = (workflowId) => collection(db, "crossTeamWorkflows", workflowId, "activity");
  const commentsRef = (workflowId, stageId) => collection(db, "crossTeamWorkflows", workflowId, "stages", stageId, "comments");
  const linksMarkup = (links) => (Array.isArray(links) ? links : []).map((link) => {
    const href = safeUrl(link?.url);
    if (!href) return "";
    const previewUrl = drivePreviewUrl(href);
    return `<div class="cross-work-link-card"><a class="cross-work-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(link.label || "Open link")}</span><span aria-hidden="true">↗</span></a>${link.sharedByName ? `<small>Shared by ${escapeHtml(link.sharedByName)}${link.sharedByRole ? ` · ${escapeHtml(roleLabel(link.sharedByRole))}` : ""}</small>` : ""}${previewUrl ? `<details class="cross-work-drive-preview"><summary>Preview in dashboard</summary><iframe src="${escapeAttr(previewUrl)}" loading="lazy" title="${escapeAttr(link.label || "Google Drive preview")}" referrerpolicy="no-referrer" allow="autoplay; fullscreen"></iframe></details>` : ""}</div>`;
  }).filter(Boolean).join("");

  async function loadRoster() {
    if (activeMembers.length) return activeMembers;
    try {
      const snapshot = await getDocs(query(collection(db, "teamMembers"), where("active", "==", true)));
      activeMembers = snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }))
        .filter((member) => member.active === true);
    } catch (_) {
      const current = ctx().member;
      activeMembers = current?.uid ? [{ ...current, active: true }] : [];
    }
    return activeMembers;
  }

  async function notifyWorkflow(workflow, roles, title, message, stageId = "") {
    if (typeof notifyInboxMembers !== "function" || !workflow?.id) return;
    try {
      const roster = await loadRoster();
      const targetRoles = new Set([...(workflow.participantRoles || []), "admin"]);
      const targetUids = new Set([
        workflow.createdByUid,
        ...(Array.isArray(workflow.participantUids) ? workflow.participantUids : [])
      ].filter(Boolean));
      const recipients = roster.filter((member) => targetRoles.has(member.role)
        || member.teamLeadRoles?.some((role) => targetRoles.has(role))
        || member.dashboardRoles?.some((role) => targetRoles.has(role))
        || targetUids.has(member.uid));
      await notifyInboxMembers(
        recipients, "cross_team_work", title, message,
        { workflowId: workflow.id, workflowRecipientRoles: [...targetRoles], ...(stageId ? { workflowStageId: stageId } : {}) },
        3,
        `cross-work-${workflow.id}-${stageId || "project"}-${Date.now()}`
      );
      return true;
    } catch (error) {
      console.warn("Cross-team inbox notice could not be delivered.", error);
      toast?.(`The workflow update was saved, but inbox alerts could not be sent. Check the published Firestore rules. ${error?.message || ""}`, "error");
      return false;
    }
  }

  async function maybeNotifyDeadline(workflow, stage) {
    const due = asDate(stage?.dueAt);
    if (!workflow || workflow.status !== "active" || stage?.status !== "in_progress" || !due) return;
    const remaining = due.getTime() - Date.now();
    if (remaining > 24 * 60 * 60 * 1000) return;
    const kind = remaining < 0 ? "overdue" : "soon";
    const title = kind === "overdue" ? "A team stage is overdue" : "A team stage deadline is coming up";
    const message = kind === "overdue"
      ? `The ${roleLabel(stage.teamRole)} stage in “${workflow.title}” passed its deadline.`
      : `The ${roleLabel(stage.teamRole)} stage in “${workflow.title}” is due ${dateLabel(stage.dueAt)}.`;
    const roster = await loadRoster();
    const assigned = new Set(stage.assignedMemberUids || []);
    const recipients = roster.filter((member) => member.role === "admin"
      || member.role === stage.teamRole
      || member.teamLeadRoles?.includes(stage.teamRole)
      || assigned.has(member.uid)
      || member.uid === workflow.createdByUid);
    await Promise.all(recipients.map(async (recipient) => {
      const id = `cross-work-deadline-${workflow.id}-${stage.id}-${kind}-${recipient.uid}`.slice(0, 180);
      try {
        await setDoc(doc(db, "teamMembers", recipient.uid, "notifications", id), {
          type: "cross_team_work", title, message,
          actorUid: ctx().user?.uid || "", actorName: "NAWRAS EDU workflow reminder",
          createdAt: serverTimestamp(), read: false,
          workflowId: workflow.id, workflowStageId: stage.id,
          workflowRecipientRoles: [stage.teamRole, "admin"]
        });
      } catch (_) {
        // A deterministic notice ID prevents a later visit from creating duplicates.
      }
    }));
  }

  async function load() {
    const c = ctx();
    if (!c.user?.uid || !c.member) return;
    if (loading) return;
    loading = true;
    if (listRoot) listRoot.innerHTML = `<div class="empty-state">Loading workflows…</div>`;
    try {
      const base = collection(db, "crossTeamWorkflows");
      let snapshots;
      if (c.role === "admin") {
        snapshots = [await getDocs(base)];
      } else {
        const queries = [
          getDocs(query(base, where("participantRoles", "array-contains", c.role))),
          getDocs(query(base, where("createdByUid", "==", c.user.uid))),
          getDocs(query(base, where("participantUids", "array-contains", c.user.uid)))
        ];
        for (const role of (Array.isArray(c.teamLeadRoles) ? c.teamLeadRoles : [])) {
          if (TEAM_ROLES.includes(role) && role !== c.role) {
            queries.push(getDocs(query(base, where("participantRoles", "array-contains", role))));
          }
        }
        for (const role of (Array.isArray(c.dashboardRoles) ? c.dashboardRoles : [])) {
          if (TEAM_ROLES.includes(role) && role !== c.role && !c.teamLeadRoles?.includes(role)) {
            queries.push(getDocs(query(base, where("participantRoles", "array-contains", role))));
          }
        }
        snapshots = await Promise.all(queries);
      }
      const map = new Map();
      snapshots.forEach((snapshot) => snapshot.docs.forEach((item) => {
        const data = { id: item.id, ...item.data() };
        data.progress = data.status === "completed" ? 100
          : Math.round((Number(data.currentStageIndex) || 0) / Math.max(1, data.stageIds?.length || 1) * 100);
        if (canReadWorkflow(data)) map.set(item.id, data);
      }));
      workflows = [...map.values()].sort((a, b) => {
        const ad = asDate(a.updatedAt || a.createdAt)?.getTime() || 0;
        const bd = asDate(b.updatedAt || b.createdAt)?.getTime() || 0;
        return bd - ad;
      });
      await loadRoster();
      const requestedWorkflow = new URLSearchParams(window.location.search).get("workflow");
      if (requestedWorkflow && workflows.some((item) => item.id === requestedWorkflow)) selectedId = requestedWorkflow;
      renderList();
      if (selectedId && workflows.some((item) => item.id === selectedId)) await openWorkflow(selectedId, false);
      else {
        selectedId = "";
        if (detailRoot) detailRoot.classList.add("hidden");
      }
    } catch (error) {
      if (listRoot) listRoot.innerHTML = `<div class="empty-state">Workflows could not be loaded. ${escapeHtml(error?.message || "")}</div>`;
      const reason = error?.message || "Unknown Firestore error";
      toast?.(`Cross-Team Work could not be loaded: ${reason}. Publish the included Firestore rules if this is a permission error.`, "error");
    } finally {
      loading = false;
    }
  }

  function isOverdue(workflow) {
    if (!workflow || workflow.status !== "active") return false;
    const due = asDate(workflow.deadline);
    return Boolean(due && due.getTime() < Date.now());
  }

  function renderList() {
    if (!listRoot) return;
    const search = (document.getElementById("crossTeamSearch")?.value || "").trim().toLowerCase();
    const filter = document.getElementById("crossTeamStatusFilter")?.value || "active";
    const visible = workflows.filter((workflow) => {
      const filterMatch = filter === "all" || (filter === "active" ? ["active", "paused"].includes(workflow.status) : workflow.status === filter);
      const searchMatch = !search || `${workflow.title} ${workflow.description} ${workflow.category} ${workflow.participantRoles.map(roleLabel).join(" ")}`.toLowerCase().includes(search);
      return filterMatch && searchMatch;
    });
    if (!visible.length) {
      listRoot.innerHTML = `<div class="cross-work-empty"><span aria-hidden="true">↗</span><strong>${workflows.length ? "No matching workflows" : "No shared workflows yet"}</strong><p>${workflows.length ? "Adjust the search or status filter." : mayCreate() ? "Start a shared project and hand work between Academy teams." : "Workflows assigned to your team will appear here."}</p></div>`;
      return;
    }
    listRoot.innerHTML = visible.map((workflow) => {
      const currentRole = workflow.stageRoles?.[workflow.currentStageIndex] || "";
      const overdue = isOverdue(workflow);
      return `<button type="button" class="cross-work-list-card ${selectedId === workflow.id ? "is-selected" : ""}" data-workflow-open="${escapeAttr(workflow.id)}">
        <span class="cross-work-card-top"><span class="cross-work-status is-${escapeAttr(workflow.status)}">${escapeHtml(workflowStatusLabel(workflow.status))}</span><span class="cross-work-priority is-${escapeAttr(String(workflow.priority || "medium").toLowerCase())}">${escapeHtml(workflow.priority || "Medium")}</span></span>
        <strong>${escapeHtml(workflow.title || "Untitled workflow")}</strong><span class="cross-work-card-category">${escapeHtml(workflow.category || "Academy project")} · ${workflow.participantRoles?.length || 0} teams</span>
        <span class="cross-work-card-progress"><span><i style="width:${Math.max(0, Math.min(100, Number(workflow.progress || 0)))}%"></i></span><small>${Math.round(workflow.progress || 0)}%</small></span>
        <span class="cross-work-card-bottom"><span>${workflow.status === "active" ? `Current: ${escapeHtml(roleLabel(currentRole))}` : escapeHtml(workflowStatusLabel(workflow.status))}</span><span class="${overdue ? "is-overdue" : ""}">${escapeHtml(dateLabel(workflow.deadline))}${overdue ? " · Overdue" : ""}</span></span>
      </button>`;
    }).join("");
  }

  function stageRoleOptions(selected = "") {
    return TEAM_ROLES.map((role) => `<option value="${role}" ${role === selected ? "selected" : ""}>${escapeHtml(roleLabel(role))}</option>`).join("");
  }

  function rosterOptions(role, selected = []) {
    const selectedSet = new Set(selected);
    return activeMembers.filter((member) => member.role === role && member.active !== false)
      .map((member) => `<option value="${escapeAttr(member.uid)}" ${selectedSet.has(member.uid) ? "selected" : ""}>${escapeHtml(member.displayName || "Member")}</option>`).join("");
  }

  function stageRowMarkup(index, initialRole = "") {
    const defaults = TEAM_ROLES.includes(initialRole) ? initialRole : "tech";
    return `<article class="cross-work-stage-editor" data-stage-row>
      <div class="cross-work-stage-editor-top"><span class="cross-work-stage-number">${index + 1}</span><label>Team<select data-stage-role>${stageRoleOptions(defaults)}</select></label><div class="cross-work-row-actions"><button type="button" class="btn btn-outline btn-compact" data-stage-up aria-label="Move stage up">↑</button><button type="button" class="btn btn-outline btn-compact" data-stage-down aria-label="Move stage down">↓</button><button type="button" class="btn btn-danger btn-compact" data-stage-remove>Remove</button></div></div>
      <label>Instructions for this team<textarea data-stage-instructions rows="2" maxlength="1000" placeholder="What should this team deliver?"></textarea></label>
      <div class="cross-work-stage-editor-fields"><label>Stage deadline<input data-stage-deadline type="date"></label><label>Responsible members (optional)<select data-stage-assignees multiple size="3">${rosterOptions(defaults)}</select><small>Leave blank to allow the full team to work on this stage.</small></label></div>
    </article>`;
  }

  function referenceRowMarkup() {
    return `<div class="cross-work-reference-row"><label>Link title<input data-reference-label maxlength="60" placeholder="e.g. Project brief"></label><label>URL<input data-reference-url type="url" maxlength="1000" placeholder="https://…"></label><button type="button" class="btn btn-outline btn-compact" data-reference-remove aria-label="Remove reference">Remove</button></div>`;
  }

  function collectReferenceLinks() {
    const rows = [...(document.getElementById("crossTeamReferenceRows")?.querySelectorAll(".cross-work-reference-row") || [])];
    const links = [];
    for (const row of rows) {
      const label = cleanText(row.querySelector("[data-reference-label]")?.value, 60);
      const rawUrl = row.querySelector("[data-reference-url]")?.value.trim() || "";
      if (!label && !rawUrl) continue;
      const url = safeUrl(rawUrl);
      if (!label || !url) return { links: [], error: "Fill in a title and a valid http or https URL for each project reference." };
      links.push({ label, url });
    }
    if (links.length > 3) return { links: [], error: "You can attach up to three project references." };
    return { links, error: "" };
  }

  function refreshStageRows() {
    if (!stageRows) return;
    [...stageRows.querySelectorAll("[data-stage-row]")].forEach((row, index) => {
      row.querySelector(".cross-work-stage-number").textContent = String(index + 1);
      const role = row.querySelector("[data-stage-role]")?.value || "";
      const assignees = row.querySelector("[data-stage-assignees]");
      const previous = [...(assignees?.selectedOptions || [])].map((option) => option.value);
      if (assignees) assignees.innerHTML = rosterOptions(role, previous);
      const up = row.querySelector("[data-stage-up]"), down = row.querySelector("[data-stage-down]");
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === stageRows.children.length - 1;
    });
    const addButton = document.getElementById("crossTeamAddStage");
    if (addButton) addButton.disabled = stageRows.children.length >= MAX_STAGES;
  }

  function stageDue(stage) {
    return dateInputValue(stage?.dueAt);
  }

  function progressFor(stages, workflow) {
    if (!stages.length) return 0;
    return Math.round(stages.filter((stage) => stage.status === "completed").length / stages.length * 100);
  }

  async function openWorkflow(id, refreshList = true) {
    const workflow = workflows.find((item) => item.id === id);
    if (!workflow || !canReadWorkflow(workflow)) return;
    selectedId = id;
    selectedWorkflow = workflow;
    if (refreshList) renderList();
    if (detailRoot) {
      detailRoot.classList.remove("hidden");
      detailRoot.innerHTML = `<div class="empty-state">Opening ${escapeHtml(workflow.title)}…</div>`;
    }
    try {
      const [stageSnapshot, activitySnapshot] = await Promise.all([
        getDocs(query(collection(db, "crossTeamWorkflows", id, "stages"), where("stageIndex", ">=", 0))),
        getDocs(collection(db, "crossTeamWorkflows", id, "activity"))
      ]);
      selectedStages = stageSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.stageIndex - b.stageIndex);
      await renderComments(id, selectedStages);
      selectedActivity = activitySnapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        .sort((a, b) => (asDate(b.createdAt)?.getTime() || 0) - (asDate(a.createdAt)?.getTime() || 0)).slice(0, 100);
      selectedWorkflow.progress = progressFor(selectedStages, workflow);
      await maybeNotifyDeadline(selectedWorkflow, selectedStages[Number(selectedWorkflow.currentStageIndex) || 0]);
      renderList();
      await renderDetail();
    } catch (error) {
      detailRoot.innerHTML = `<div class="empty-state">This workflow detail could not be opened. ${escapeHtml(error?.message || "")}</div>`;
    }
  }

  async function renderDetail() {
    if (!detailRoot || !selectedWorkflow) return;
    const workflow = selectedWorkflow;
    const activeIndex = Number(workflow.currentStageIndex) || 0;
    const canAdmin = isAdmin();
    const stages = selectedStages;
    const allDone = workflow.status === "completed";
    const currentStage = stages[activeIndex];
    const referenceLinks = linksMarkup(workflow.referenceLinks || []);
    const stageMarkup = stages.map((stage, index) => {
      const active = workflow.status === "active" && index === activeIndex;
      const canWork = active && canManageStage(stage);
      const isNext = workflow.status === "active" && index === activeIndex + 1;
      const assigned = (stage.assignedMemberUids || []).map((memberUid) => activeMembers.find((m) => m.uid === memberUid)?.displayName || "Assigned member").join(", ");
      const comments = stage.comments || [];
      const links = linksMarkup(stage.links);
      const due = stage.dueAt ? dateLabel(stage.dueAt) : "No stage deadline";
      const stageDueDate = asDate(stage.dueAt);
      const stageOverdue = active && stage.status === "in_progress" && stageDueDate && stageDueDate.getTime() < Date.now();
      const adminStageControls = canAdmin ? `<div class="cross-work-admin-stage-tools">
        <label>Instructions<textarea data-stage-edit-instructions="${escapeAttr(stage.id)}" maxlength="1000" rows="2">${escapeHtml(stage.instructions || "")}</textarea></label>
        <div class="cross-work-stage-editor-fields"><label>Deadline<input type="date" data-stage-edit-deadline="${escapeAttr(stage.id)}" value="${escapeAttr(stageDue(stage))}"></label><label>Responsible members<select multiple size="3" data-stage-edit-assignees="${escapeAttr(stage.id)}">${rosterOptions(stage.teamRole, stage.assignedMemberUids || [])}</select></label></div>
        <button type="button" class="btn btn-outline btn-compact" data-stage-save="${escapeAttr(stage.id)}">Save stage settings</button>
      </div>` : "";
      const reviewButtons = canAdmin && stage.status === "submitted"
        ? `<div class="cross-work-review-actions"><button type="button" class="btn btn-primary btn-compact" data-stage-approve="${escapeAttr(stage.id)}">Approve and hand over</button><button type="button" class="btn btn-outline btn-compact" data-stage-revise="${escapeAttr(stage.id)}">Return for revision</button></div>`
        : "";
      const memberActions = canWork && ["in_progress", "needs_revision"].includes(stage.status)
        ? `<form class="cross-work-stage-submit" data-stage-submit-form="${escapeAttr(stage.id)}"><label>Handover note<textarea data-handover-note maxlength="1500" rows="3" placeholder="Summarize the work and tell the next team what they need to know.">${escapeHtml(stage.handoverNote || "")}</textarea></label><button type="submit" class="btn btn-primary btn-compact">${workflow.reviewMode ? "Submit for review" : index === stages.length - 1 ? "Complete workflow" : "Complete and hand over"}</button></form>` : "";
      const linkForm = canWork ? `<form class="cross-work-link-form" data-stage-link-form="${escapeAttr(stage.id)}"><label>Share a deliverable or reference link<input type="text" name="label" maxlength="60" placeholder="Link title" required></label><label>URL<input type="url" name="url" maxlength="1000" placeholder="https://drive.google.com/…" required></label><button type="submit" class="btn btn-outline btn-compact">Add link</button></form>` : "";
      const commentForm = canWork ? `<form class="cross-work-comment-form" data-stage-comment-form="${escapeAttr(stage.id)}"><label>Team update or feedback<textarea name="text" maxlength="1000" rows="2" placeholder="Share a comment with the project team…" required></textarea></label><button type="submit" class="btn btn-outline btn-compact">Post update</button></form>` : "";
      const orderingButtons = canAdmin && index > activeIndex
        ? `<div class="cross-work-row-actions"><button type="button" class="btn btn-outline btn-compact" data-stage-order="${escapeAttr(stage.id)}" data-direction="-1" ${index === activeIndex + 1 ? "disabled" : ""}>Move up</button><button type="button" class="btn btn-outline btn-compact" data-stage-order="${escapeAttr(stage.id)}" data-direction="1" ${index === stages.length - 1 ? "disabled" : ""}>Move down</button><button type="button" class="btn btn-danger btn-compact" data-stage-delete="${escapeAttr(stage.id)}">Remove pending team</button></div>` : "";
      const statusClass = `is-${stage.status}`;
      return `<article class="cross-work-stage ${active ? "is-current" : ""} ${stage.status === "completed" ? "is-complete" : ""}" data-stage-id="${escapeAttr(stage.id)}">
        <div class="cross-work-stage-marker"><span>${stage.status === "completed" ? "✓" : index + 1}</span>${index < stages.length - 1 ? "<i></i>" : ""}</div>
        <div class="cross-work-stage-content">
          <div class="cross-work-stage-heading"><div><span class="cross-work-stage-team">${escapeHtml(roleLabel(stage.teamRole))}${assigned ? ` · ${escapeHtml(assigned)}` : ""}</span><h4>${escapeHtml(roleLabel(stage.teamRole))} stage</h4></div><span class="cross-work-stage-status ${statusClass}">${escapeHtml(stageStatusLabel(stage.status))}</span></div>
          <p class="cross-work-stage-meta ${stageOverdue ? "is-overdue" : ""}">${escapeHtml(due)}${stageOverdue ? " · Overdue" : ""}${stage.submittedAt ? ` · Submitted ${escapeHtml(relativeTime(stage.submittedAt))}` : ""}${isNext ? " · Up next" : active ? " · Current team" : ""}</p>
          ${stage.instructions ? `<p class="cross-work-stage-instructions">${escapeHtml(stage.instructions)}</p>` : ""}
          ${stage.handoverNote ? `<div class="cross-work-handover"><strong>Handover note</strong><p>${escapeHtml(stage.handoverNote)}</p></div>` : ""}
          <div class="cross-work-links">${links || `<span class="cross-work-subtle">No shared links yet.</span>`}</div>
          <div class="cross-work-comments">${comments.length ? comments.map((comment) => `<article class="cross-work-comment"><div><strong>${escapeHtml(comment.actorName || "Team member")}</strong><small>${escapeHtml(roleLabel(comment.actorRole))} · ${escapeHtml(relativeTime(comment.createdAt))}</small></div><p>${escapeHtml(comment.text || "")}</p></article>`).join("") : `<span class="cross-work-subtle">No updates yet.</span>`}</div>
          ${linkForm}${commentForm}${memberActions}${reviewButtons}${adminStageControls}${orderingButtons}
        </div>
      </article>`;
    }).join("");
    const allRoles = (workflow.stageRoles || []).map((role, index) => `<span class="cross-work-role-chip">${index + 1}. ${escapeHtml(roleLabel(role))}</span>`).join("");
    const adminControls = canAdmin ? `<div class="cross-work-admin-controls">
      ${["active", "paused"].includes(workflow.status) ? `<button type="button" class="btn btn-outline btn-compact" data-workflow-toggle="${workflow.status === "paused" ? "active" : "paused"}">${workflow.status === "paused" ? "Resume workflow" : "Pause workflow"}</button>` : ""}
      ${!["completed", "cancelled"].includes(workflow.status) ? `<button type="button" class="btn btn-danger btn-compact" data-workflow-cancel>Cancel workflow</button>` : ""}
      <form class="cross-work-deadline-form"><label>Overall deadline<input type="date" name="deadline" value="${escapeAttr(dateInputValue(workflow.deadline))}"></label><button type="submit" class="btn btn-outline btn-compact">Save deadline</button></form>
    </div>
    <form class="cross-work-add-stage-form ${["completed", "cancelled"].includes(workflow.status) ? "hidden" : ""}"><strong>Add a participating team</strong><div class="cross-work-stage-editor-fields"><label>Team<select name="teamRole">${stageRoleOptions("tech")}</select></label><label>Deadline<input type="date" name="dueAt"></label></div><label>Instructions<textarea name="instructions" maxlength="1000" rows="2"></textarea></label><label>Responsible members<select name="assignees" multiple size="3"></select></label><button type="submit" class="btn btn-primary btn-compact" ${stages.length >= MAX_STAGES ? "disabled" : ""}>Add future stage</button></form>` : "";
    const activityMarkup = selectedActivity.length ? selectedActivity.map((item) => `<article class="cross-work-activity-item"><span class="cross-work-activity-dot"></span><div><strong>${escapeHtml(item.actorName || "Member")} · ${escapeHtml(item.action || "updated the workflow")}</strong><small>${escapeHtml(item.stageRole ? `${roleLabel(item.stageRole)} · ` : "")}${escapeHtml(relativeTime(item.createdAt))}</small>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}</div></article>`).join("") : `<p class="cross-work-subtle">Activity appears here as teams work and hand over.</p>`;
    detailRoot.innerHTML = `<section class="cross-work-detail-card">
      <header class="cross-work-detail-heading"><div><button type="button" class="cross-work-back" data-workflow-back>← All workflows</button><div class="cross-work-detail-kicker">${escapeHtml(workflow.category || "Academy project")} · ${escapeHtml(workflowStatusLabel(workflow.status))}</div><h3>${escapeHtml(workflow.title)}</h3><p>${escapeHtml(workflow.description || "")}</p></div><span class="cross-work-priority is-${escapeAttr(String(workflow.priority || "medium").toLowerCase())}">${escapeHtml(workflow.priority || "Medium")} priority</span></header>
      <div class="cross-work-summary"><span><strong>${Math.round(workflow.progress || 0)}%</strong> Complete</span><span><strong>${stages.filter((stage) => stage.status === "completed").length}/${stages.length}</strong> Teams finished</span><span><strong>${escapeHtml(dateLabel(workflow.deadline))}</strong> Overall deadline${isOverdue(workflow) ? " · Overdue" : ""}</span></div>
      <div class="cross-work-project-track"><div class="cross-work-track-line"><i style="width:${Math.max(0, Math.min(100, workflow.progress || 0))}%"></i></div><div class="cross-work-track-roles">${allRoles}</div></div>
      <p class="cross-work-subtle">Last activity: ${escapeHtml(relativeTime(selectedActivity[0]?.createdAt || workflow.lastActivityAt))} · Created by ${escapeHtml(workflow.createdByName || "Academy member")}</p>
      ${referenceLinks ? `<section class="cross-work-reference-links"><h4>Project references</h4>${referenceLinks}</section>` : ""}
      ${adminControls}
      <section class="cross-work-stage-list"><div class="cross-work-section-heading"><div><span>Team handover plan</span><h4>${workflow.status === "paused" ? "Paused" : allDone ? "All teams completed" : currentStage ? `${roleLabel(currentStage.teamRole)} is up now` : "Workflow stages"}</h4></div><span class="cross-work-small-note">${stages.length} ordered stages</span></div>${stageMarkup || `<div class="cross-work-subtle">No stages were added.</div>`}</section>
      <section class="cross-work-history"><div class="cross-work-section-heading"><div><span>Audit trail</span><h4>Activity history</h4></div></div><div class="cross-work-activity">${activityMarkup}</div></section>
    </section>`;
    const addRole = detailRoot.querySelector(".cross-work-add-stage-form [name=teamRole]");
    const addMembers = detailRoot.querySelector(".cross-work-add-stage-form [name=assignees]");
    if (addRole && addMembers) addMembers.innerHTML = rosterOptions(addRole.value);
  }

  async function renderComments(workflowId, stages) {
    const comments = await Promise.all(stages.map(async (stage) => {
      try {
        const snapshot = await getDocs(commentsRef(workflowId, stage.id));
        return [stage.id, snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) => (asDate(a.createdAt)?.getTime() || 0) - (asDate(b.createdAt)?.getTime() || 0))];
      } catch (_) { return [stage.id, []]; }
    }));
    const map = new Map(comments);
    selectedStages = selectedStages.map((stage) => ({ ...stage, comments: map.get(stage.id) || [] }));
  }

  async function refreshDetail() {
    if (!selectedId) return;
    const [workflowSnapshot, stageSnapshot, activitySnapshot] = await Promise.all([
      getDoc(workflowRef(selectedId)),
      getDocs(query(collection(db, "crossTeamWorkflows", selectedId, "stages"), where("stageIndex", ">=", 0))),
      getDocs(collection(db, "crossTeamWorkflows", selectedId, "activity"))
    ]);
    if (!workflowSnapshot.exists()) {
      selectedId = "";
      selectedWorkflow = null;
      detailRoot?.classList.add("hidden");
      return load();
    }
    selectedWorkflow = { id: workflowSnapshot.id, ...workflowSnapshot.data() };
    selectedStages = stageSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.stageIndex - b.stageIndex);
    selectedActivity = activitySnapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (asDate(b.createdAt)?.getTime() || 0) - (asDate(a.createdAt)?.getTime() || 0)).slice(0, 100);
    await renderComments(selectedId, selectedStages);
    selectedWorkflow.progress = progressFor(selectedStages, selectedWorkflow);
    await maybeNotifyDeadline(selectedWorkflow, selectedStages[Number(selectedWorkflow.currentStageIndex) || 0]);
    workflows = workflows.map((item) => item.id === selectedId ? selectedWorkflow : item);
    renderList();
    await renderDetail();
  }

  function updateWorkflowSummary(rootData, status, currentStageIndex, extra = {}) {
    return { status, currentStageIndex, updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp(), ...extra };
  }

  function actorInfo() {
    const c = ctx();
    return {
      actorUid: c.user?.uid || "", actorName: cleanText(c.member?.displayName || c.user?.displayName || "Member", 80),
      actorRole: c.role || "user"
    };
  }

  async function submitStage(stageId, note) {
    const workflow = selectedWorkflow;
    const stage = selectedStages.find((item) => item.id === stageId);
    if (!workflow || !stage || workflow.status !== "active" || Number(workflow.currentStageIndex) !== stage.stageIndex
      || !canManageStage(stage)) return toast?.("Only the active team can submit this stage.", "error");
    const handoverNote = cleanText(note, 1500);
    if (handoverNote.length < 3) return toast?.("Add a short handover note before submitting.", "error");
    const nextStage = selectedStages[stage.stageIndex + 1];
    const actor = actorInfo();
    const batch = writeBatch(db);
    batch.update(stageRef(workflow.id, stage.id), {
      status: workflow.reviewMode ? "submitted" : "completed", handoverNote,
      submittedAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedByUid: actor.actorUid
    });
    if (!workflow.reviewMode) {
      if (nextStage) batch.update(stageRef(workflow.id, nextStage.id), { status: "in_progress", startedAt: serverTimestamp(), updatedAt: serverTimestamp() });
      batch.update(workflowRef(workflow.id), updateWorkflowSummary(workflow, nextStage ? "active" : "completed",
        nextStage ? stage.stageIndex + 1 : stage.stageIndex, {
          progress: Math.round((stage.stageIndex + 1) / selectedStages.length * 100)
        }));
    }
    batch.set(doc(activityRef(workflow.id)), {
      ...actor, action: workflow.reviewMode ? "submitted a stage for review" : "completed a stage",
      detail: handoverNote.slice(0, 500), stageId: stage.id, stageRole: stage.teamRole, createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow(workflow, workflow.reviewMode ? ["admin"] : nextStage ? [nextStage.teamRole] : workflow.participantRoles,
      workflow.reviewMode ? `${roleLabel(stage.teamRole)} submitted work` : nextStage ? `${roleLabel(nextStage.teamRole)} stage is active` : "Cross-Team Work completed",
      workflow.reviewMode ? `${actor.actorName} submitted a stage for review in “${workflow.title}”.` : nextStage ? `The ${roleLabel(nextStage.teamRole)} team can begin its stage in “${workflow.title}”.` : `All stages in “${workflow.title}” are complete.`,
      nextStage?.id || stage.id);
    await refreshDetail();
  }

  async function reviewStage(stageId, approve) {
    if (!isAdmin()) return toast?.("Only admins can review workflow stages.", "error");
    const workflow = selectedWorkflow;
    const stage = selectedStages.find((item) => item.id === stageId);
    if (!workflow || workflow.status !== "active" || !stage || stage.status !== "submitted" || stage.stageIndex !== Number(workflow.currentStageIndex)) {
      return toast?.("This stage is not waiting for review.", "error");
    }
    const nextStage = selectedStages[stage.stageIndex + 1];
    const actor = actorInfo();
    const batch = writeBatch(db);
    if (approve) {
      batch.update(stageRef(workflow.id, stage.id), { status: "completed", reviewedAt: serverTimestamp(), reviewedByUid: actor.actorUid, updatedAt: serverTimestamp() });
      if (nextStage) batch.update(stageRef(workflow.id, nextStage.id), { status: "in_progress", startedAt: serverTimestamp(), updatedAt: serverTimestamp() });
      batch.update(workflowRef(workflow.id), updateWorkflowSummary(workflow, nextStage ? "active" : "completed",
        nextStage ? stage.stageIndex + 1 : stage.stageIndex, {
          progress: Math.round((stage.stageIndex + 1) / selectedStages.length * 100)
        }));
    } else {
      batch.update(stageRef(workflow.id, stage.id), { status: "needs_revision", reviewedAt: serverTimestamp(), reviewedByUid: actor.actorUid, updatedAt: serverTimestamp() });
    }
    batch.set(doc(activityRef(workflow.id)), {
      ...actor, action: approve ? "approved a stage" : "returned a stage for revision",
      detail: approve ? (nextStage ? `Work handed over to ${roleLabel(nextStage.teamRole)}.` : "All workflow stages are complete.") : "The active team should review the stage and submit it again.",
      stageId: stage.id, stageRole: stage.teamRole, createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow(workflow, approve ? (nextStage ? [nextStage.teamRole] : workflow.participantRoles) : [stage.teamRole],
      approve ? (nextStage ? `${roleLabel(nextStage.teamRole)} stage is active` : "Cross-Team Work completed") : "A stage needs revision",
      approve ? (nextStage ? `The ${roleLabel(nextStage.teamRole)} team can begin “${workflow.title}”.` : `All stages in “${workflow.title}” are complete.`)
        : `The ${roleLabel(stage.teamRole)} stage in “${workflow.title}” was returned for revision.`, nextStage?.id || stage.id);
    await refreshDetail();
  }

  async function createWorkflow(event) {
    event.preventDefault();
    if (!mayCreate()) return toast?.("You need a team-leader or task-management permission to create a workflow.", "error");
    const form = event.currentTarget;
    const submit = form.querySelector("[type=submit]");
    if (submit) submit.disabled = true;
    let committed = false;
    try {
      const field = (name) => form.elements.namedItem(name);
      const title = cleanText(field("title")?.value, 120);
      const description = cleanText(field("description")?.value, 1000);
      const category = cleanText(field("category")?.value, 80) || "Academy project";
      const priority = PRIORITIES.includes(field("priority")?.value) ? field("priority").value : "Medium";
      const rowNodes = [...(stageRows?.querySelectorAll("[data-stage-row]") || [])];
      if (title.length < 3 || description.length < 8) return toast?.("Add a title and a short project description.", "error");
      if (rowNodes.length < 2) return toast?.("Choose at least two teams for a cross-team workflow.", "error");
      if (rowNodes.length > MAX_STAGES) return toast?.(`A workflow can have up to ${MAX_STAGES} stages.`, "error");
      const roles = rowNodes.map((row) => row.querySelector("[data-stage-role]")?.value || "");
      if (roles.some((role) => !TEAM_ROLES.includes(role))) return toast?.("Choose a valid team for every stage.", "error");
      if (new Set(roles).size < 2) return toast?.("Choose at least two different teams for a cross-team workflow.", "error");
      const references = collectReferenceLinks();
      if (references.error) return toast?.(references.error, "error");
      const stagesInput = rowNodes.map((row, index) => ({
        stageIndex: index, teamRole: roles[index],
        instructions: cleanText(row.querySelector("[data-stage-instructions]")?.value, 1000),
        dueAt: dateFromInput(row.querySelector("[data-stage-deadline]")?.value),
        assignedMemberUids: [...(row.querySelector("[data-stage-assignees]")?.selectedOptions || [])].map((item) => item.value).slice(0, 20)
      }));
      const c = ctx();
      const actor = actorInfo();
      if (!actor.actorUid) throw new Error("Your login session expired. Sign in again before creating a workflow.");
      const workflowId = doc(collection(db, "crossTeamWorkflows")).id;
      const workflow = {
        id: workflowId, title, description, category, priority,
        deadline: dateFromInput(field("deadline")?.value),
        reviewMode: Boolean(field("reviewMode")?.checked),
        createdByUid: actor.actorUid, createdByName: actor.actorName, createdByRole: actor.actorRole,
        participantRoles: [...new Set(roles)], stageRoles: roles, participantUids: [...new Set(stagesInput.flatMap((stage) => stage.assignedMemberUids))],
        referenceLinks: references.links,
        stageIds: [], currentStageIndex: 0, status: "active", progress: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp()
      };
      const batch = writeBatch(db);
      const workflowDocument = doc(db, "crossTeamWorkflows", workflowId);
      const stageDocuments = stagesInput.map((stage) => ({ id: doc(collection(db, "crossTeamWorkflows", workflowId, "stages")).id, ...stage }));
      workflow.stageIds = stageDocuments.map((stage) => stage.id);
      batch.set(workflowDocument, workflow);
      stageDocuments.forEach((stage, index) => {
        batch.set(stageRef(workflowId, stage.id), {
          workflowId, stageId: stage.id, stageIndex: index, teamRole: stage.teamRole,
          instructions: stage.instructions, dueAt: stage.dueAt,
          assignedMemberUids: stage.assignedMemberUids,
          status: index === 0 ? "in_progress" : "pending",
          links: [], handoverNote: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
          ...(index === 0 ? { startedAt: serverTimestamp() } : {})
        });
      });
      batch.set(doc(activityRef(workflowId)), {
        ...actor, action: "created a cross-team workflow", detail: title,
        stageId: stageDocuments[0]?.id || "", stageRole: stageDocuments[0]?.teamRole || "", createdAt: serverTimestamp()
      });
      await batch.commit();
      committed = true;
      form.reset();
      const referenceRows = document.getElementById("crossTeamReferenceRows");
      if (referenceRows) referenceRows.innerHTML = "";
      if (stageRows) stageRows.innerHTML = stageRowMarkup(0, c.role === "admin" ? "event" : c.role) + stageRowMarkup(1, "tech");
      refreshStageRows();
      form.classList.add("hidden");
      const notified = await notifyWorkflow({ ...workflow }, workflow.participantRoles, "A new team workflow is ready",
        `${actor.actorName} assigned the first stage of “${title}” to ${roleLabel(stageDocuments[0]?.teamRole)}.`, stageDocuments[0]?.id);
      toast?.(notified ? "Cross-Team Work workflow created." : "Workflow created, but some inbox alerts need attention.");
      await load();
      await openWorkflow(workflowId);
    } catch (error) {
      console.error("Cross-Team Work workflow creation failed.", error);
      toast?.(committed
        ? `The workflow was created, but the page could not refresh. Reload to view it. ${error?.message || ""}`
        : `The workflow could not be created: ${error?.message || "Check the published Firestore rules."}`, "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function addComment(stageId, text) {
    const stage = selectedStages.find((item) => item.id === stageId);
    if (!stage || !canManageStage(stage) || !selectedWorkflow || selectedWorkflow.status !== "active"
      || Number(selectedWorkflow.currentStageIndex) !== stage.stageIndex || !["in_progress", "needs_revision"].includes(stage.status)) {
      return toast?.("Only the active team can post an update in this stage.", "error");
    }
    const message = cleanText(text, 1000);
    if (message.length < 2) return toast?.("Write a little more before posting.", "error");
    const actor = actorInfo();
    const comment = doc(commentsRef(selectedWorkflow.id, stageId));
    const batch = writeBatch(db);
    batch.set(comment, { ...actor, text: message, createdAt: serverTimestamp() });
    batch.set(doc(activityRef(selectedWorkflow.id)), {
      ...actor, action: "posted a team update", detail: message.slice(0, 300),
      stageId, stageRole: stage.teamRole, createdAt: serverTimestamp()
    });
    batch.update(workflowRef(selectedWorkflow.id), { updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
    await batch.commit();
    await notifyWorkflow(selectedWorkflow, selectedWorkflow.participantRoles,
      `Update in ${roleLabel(stage.teamRole)} stage`, `${actor.actorName} posted an update in “${selectedWorkflow.title}”.`, stageId);
    await refreshDetail();
  }

  async function addLink(stageId, label, rawUrl) {
    const stage = selectedStages.find((item) => item.id === stageId);
    const url = safeUrl(rawUrl);
    const linkLabel = cleanText(label, 60);
    if (!stage || !url || !linkLabel) return toast?.("Enter a title and a valid http or https link.", "error");
    if (!canManageStage(stage) || selectedWorkflow?.status !== "active"
      || Number(selectedWorkflow.currentStageIndex) !== stage.stageIndex || !["in_progress", "needs_revision"].includes(stage.status)) {
      return toast?.("Only the active team can add links to this stage.", "error");
    }
    const actor = actorInfo();
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(stageRef(selectedWorkflow.id, stageId));
      if (!snapshot.exists()) throw new Error("This stage no longer exists.");
      const links = snapshot.data().links || [];
      if (links.length >= 6) throw new Error("Each stage can share up to 6 links.");
      transaction.update(stageRef(selectedWorkflow.id, stageId), {
        links: [...links, { label: linkLabel, url, sharedByUid: actor.actorUid, sharedByName: actor.actorName, sharedByRole: actor.actorRole }],
        updatedByUid: actor.actorUid,
        updatedAt: serverTimestamp()
      });
      transaction.set(doc(activityRef(selectedWorkflow.id)), {
        ...actor, action: "shared a link", detail: linkLabel, stageId,
        stageRole: stage.teamRole, createdAt: serverTimestamp()
      });
    });
    await notifyWorkflow(selectedWorkflow, selectedWorkflow.participantRoles,
      `New link in ${roleLabel(stage.teamRole)} stage`, `${actor.actorName} shared “${linkLabel}” in “${selectedWorkflow.title}”.`, stageId);
    await refreshDetail();
  }

  async function saveStageSettings(stageId) {
    if (!isAdmin()) return;
    const stage = selectedStages.find((item) => item.id === stageId);
    const instructions = cleanText(detailRoot.querySelector(`[data-stage-edit-instructions="${CSS.escape(stageId)}"]`)?.value, 1000);
    const deadline = dateFromInput(detailRoot.querySelector(`[data-stage-edit-deadline="${CSS.escape(stageId)}"]`)?.value);
    const assignees = [...(detailRoot.querySelector(`[data-stage-edit-assignees="${CSS.escape(stageId)}"]`)?.selectedOptions || [])].map((item) => item.value).slice(0, 20);
    const batch = writeBatch(db);
    batch.update(stageRef(selectedWorkflow.id, stageId), { instructions, dueAt: deadline, assignedMemberUids: assignees, updatedAt: serverTimestamp() });
    batch.update(workflowRef(selectedWorkflow.id), {
      participantUids: [...new Set(selectedStages.flatMap((item) => item.id === stageId ? assignees : (item.assignedMemberUids || [])))],
      updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp()
    });
    batch.set(doc(activityRef(selectedWorkflow.id)), {
      ...actorInfo(), action: "updated a stage’s instructions, deadline, or assignment",
      detail: (instructions || dateLabel(deadline)).slice(0, 500), stageId, stageRole: stage.teamRole, createdAt: serverTimestamp()
    });
    await batch.commit();
    const nextWorkflow = {
      ...selectedWorkflow,
      participantUids: [...new Set(selectedStages.flatMap((item) =>
        item.id === stageId ? assignees : (item.assignedMemberUids || [])))]
    };
    await notifyWorkflow(nextWorkflow, nextWorkflow.participantRoles, "Workflow assignments updated",
      `The assignment for the ${roleLabel(stage.teamRole)} stage in “${selectedWorkflow.title}” changed.`, stageId);
    await refreshDetail();
  }

  async function toggleWorkflow(status) {
    if (!isAdmin() || !["active", "paused"].includes(status)) return;
    const batch = writeBatch(db);
    batch.update(workflowRef(selectedWorkflow.id), { status, updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
    batch.set(doc(activityRef(selectedWorkflow.id)), {
      ...actorInfo(), action: status === "paused" ? "paused the workflow" : "resumed the workflow",
      detail: "", stageId: "", stageRole: "", createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow(selectedWorkflow, selectedWorkflow.participantRoles,
      status === "paused" ? "A workflow was paused" : "A workflow resumed",
      `“${selectedWorkflow.title}” is now ${status}.`);
    await refreshDetail();
  }

  async function setOverallDeadline(form) {
    if (!isAdmin()) return;
    const deadline = dateFromInput(form.elements.deadline.value);
    const batch = writeBatch(db);
    batch.update(workflowRef(selectedWorkflow.id), { deadline, updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
    batch.set(doc(activityRef(selectedWorkflow.id)), {
      ...actorInfo(), action: "changed the overall deadline", detail: dateLabel(deadline),
      stageId: "", stageRole: "", createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow(selectedWorkflow, selectedWorkflow.participantRoles, "Workflow deadline updated",
      `The overall deadline for “${selectedWorkflow.title}” changed to ${dateLabel(deadline)}.`);
    await refreshDetail();
  }

  async function addFutureStage(form) {
    if (!isAdmin() || selectedStages.length >= MAX_STAGES
      || !["active", "paused"].includes(selectedWorkflow?.status)) return;
    const teamRole = form.elements.teamRole.value;
    if (!TEAM_ROLES.includes(teamRole)) return toast?.("Choose a valid team.", "error");
    const assignedMemberUids = [...form.elements.assignees.selectedOptions].map((item) => item.value).slice(0, 20);
    const workflow = selectedWorkflow;
    const id = doc(collection(db, "crossTeamWorkflows", workflow.id, "stages")).id;
    const order = selectedStages.length;
    const participantRoles = [...new Set([...workflow.participantRoles, teamRole])];
    const participantUids = [...new Set([...workflow.participantUids, ...assignedMemberUids])];
    const batch = writeBatch(db);
    batch.set(stageRef(workflow.id, id), {
      workflowId: workflow.id, stageId: id, stageIndex: order, teamRole,
      instructions: cleanText(form.elements.instructions.value, 1000),
      dueAt: dateFromInput(form.elements.dueAt.value), assignedMemberUids,
      status: "pending", links: [], handoverNote: "",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    batch.update(workflowRef(workflow.id), {
      stageIds: [...workflow.stageIds, id], stageRoles: [...workflow.stageRoles, teamRole], participantRoles, participantUids,
      progress: progressFor([...selectedStages, { status: "pending" }], workflow),
      updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp()
    });
    batch.set(doc(activityRef(workflow.id)), {
      ...actorInfo(), action: "added a future team stage", detail: roleLabel(teamRole),
      stageId: id, stageRole: teamRole, createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow({ ...workflow, participantRoles, participantUids }, [teamRole], `${roleLabel(teamRole)} added to a workflow`,
      `A future ${roleLabel(teamRole)} stage was added to “${workflow.title}”.`, id);
    await refreshDetail();
  }

  async function removeFutureStage(stageId) {
    if (!isAdmin()) return;
    const workflow = selectedWorkflow;
    const stage = selectedStages.find((item) => item.id === stageId);
    if (!stage || stage.stageIndex <= Number(workflow.currentStageIndex) || stage.status !== "pending") return;
    if (selectedStages.length <= 2) return toast?.("Keep at least two stages in a cross-team workflow.", "error");
    if (!window.confirm(`Remove the pending ${roleLabel(stage.teamRole)} stage?`)) return;
    const order = selectedStages.filter((item) => item.id !== stageId);
    const ids = order.map((item) => item.id);
    const roles = [...new Set(order.map((item) => item.teamRole))];
    const nextAssignments = order.flatMap((item) => item.assignedMemberUids || []);
    const batch = writeBatch(db);
    batch.delete(stageRef(workflow.id, stageId));
    order.forEach((item, index) => {
      if (item.stageIndex !== index) batch.update(stageRef(workflow.id, item.id), { stageIndex: index, updatedAt: serverTimestamp() });
    });
    batch.update(workflowRef(workflow.id), {
      stageIds: ids, stageRoles: order.map((item) => item.teamRole), participantRoles: roles, participantUids: [...new Set(nextAssignments)],
      progress: progressFor(order, workflow),
      updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp()
    });
    batch.set(doc(activityRef(workflow.id)), {
      ...actorInfo(), action: "removed a pending team stage", detail: roleLabel(stage.teamRole),
      stageId, stageRole: stage.teamRole, createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow({
      ...workflow,
      stageIds: ids,
      stageRoles: order.map((item) => item.teamRole),
      participantRoles: roles,
      participantUids: [...new Set(nextAssignments)]
    }, roles, `${roleLabel(stage.teamRole)} stage removed`,
    `The pending ${roleLabel(stage.teamRole)} stage was removed from “${workflow.title}”.`);
    await refreshDetail();
  }

  async function reorderFutureStage(stageId, direction) {
    if (!isAdmin()) return;
    const workflow = selectedWorkflow;
    const list = [...selectedStages];
    const index = list.findIndex((item) => item.id === stageId);
    const targetIndex = index + Number(direction);
    if (index <= Number(workflow.currentStageIndex) || targetIndex <= Number(workflow.currentStageIndex) || targetIndex >= list.length) return;
    [list[index], list[targetIndex]] = [list[targetIndex], list[index]];
    const batch = writeBatch(db);
    list.forEach((stage, order) => {
      if (stage.stageIndex !== order) batch.update(stageRef(workflow.id, stage.id), { stageIndex: order, updatedAt: serverTimestamp() });
    });
    batch.update(workflowRef(workflow.id), {
      stageIds: list.map((stage) => stage.id),
      stageRoles: list.map((stage) => stage.teamRole),
      participantRoles: [...new Set(list.map((stage) => stage.teamRole))],
      participantUids: [...new Set(list.flatMap((stage) => stage.assignedMemberUids || []))],
      updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp()
    });
    batch.set(doc(activityRef(workflow.id)), {
      ...actorInfo(), action: "reordered future team stages", detail: list.map((stage) => roleLabel(stage.teamRole)).join(" → "),
      stageRole: "", stageId: "", createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow({
      ...workflow,
      stageIds: list.map((stage) => stage.id),
      stageRoles: list.map((stage) => stage.teamRole),
      participantRoles: [...new Set(list.map((stage) => stage.teamRole))],
      participantUids: [...new Set(list.flatMap((stage) => stage.assignedMemberUids || []))]
    }, workflow.participantRoles, "Workflow stages reordered",
    `The stage order for “${workflow.title}” changed.`);
    await refreshDetail();
  }

  async function cancelWorkflow() {
    if (!isAdmin()) return;
    const reason = cleanText(window.prompt("Add a cancellation reason for the activity history:"), 500);
    if (reason.length < 3) return toast?.("Enter a short cancellation reason.", "error");
    const workflow = selectedWorkflow;
    const actor = actorInfo();
    const batch = writeBatch(db);
    batch.update(workflowRef(workflow.id), { status: "cancelled", cancelReason: reason, updatedAt: serverTimestamp(), lastActivityAt: serverTimestamp() });
    batch.set(doc(activityRef(workflow.id)), {
      ...actor, action: "cancelled the workflow", detail: reason,
      stageId: "", stageRole: "", createdAt: serverTimestamp()
    });
    await batch.commit();
    await notifyWorkflow(workflow, workflow.participantRoles, "A workflow was cancelled",
      `“${workflow.title}” was cancelled. Reason: ${reason}`);
    await refreshDetail();
  }

  function showCreateForm(show = true) {
    if (!createForm) return;
    createForm.classList.toggle("hidden", !show);
    if (show && stageRows && !stageRows.children.length) {
      const c = ctx();
      stageRows.innerHTML = stageRowMarkup(0, c.role === "admin" ? "event" : c.role) + stageRowMarkup(1, "tech");
    }
    refreshStageRows();
    if (show) createForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const runAction = (action) => {
    void Promise.resolve(action).catch((error) => {
      console.error("Cross-Team Work action failed.", error);
      toast?.(`The change could not be saved. ${error?.message || "Please refresh and try again."}`, "error");
    });
  };

  document.getElementById("crossTeamCreateButton")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (!mayCreate()) return toast?.("Only admins and Event position leaders can create workflows.", "error");
    showCreateForm(true);
  });
  document.getElementById("crossTeamCancelCreate")?.addEventListener("click", (event) => {
    event.preventDefault();
    showCreateForm(false);
  });
  createForm?.addEventListener("submit", (event) => { void createWorkflow(event); });

  panel.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.id === "crossTeamAddStage" || target.hasAttribute("data-stage-add")) {
      if (stageRows?.children.length >= MAX_STAGES) return;
      stageRows?.insertAdjacentHTML("beforeend", stageRowMarkup(stageRows.children.length, "tech"));
      refreshStageRows();
      return;
    }
    if (target.id === "crossTeamAddReference") {
      const rows = document.getElementById("crossTeamReferenceRows");
      if (rows?.children.length >= 3) return toast?.("You can add up to three project references.", "error");
      rows?.insertAdjacentHTML("beforeend", referenceRowMarkup());
      return;
    }
    if (target.hasAttribute("data-reference-remove")) {
      target.closest(".cross-work-reference-row")?.remove();
      return;
    }
    if (target.hasAttribute("data-workflow-open")) return void openWorkflow(target.dataset.workflowOpen);
    if (target.hasAttribute("data-workflow-back")) {
      selectedId = "";
      selectedWorkflow = null;
      detailRoot?.classList.add("hidden");
      renderList();
      return;
    }
    if (target.hasAttribute("data-stage-remove")) {
      if (stageRows?.children.length <= 2) return toast?.("Keep at least two teams in the workflow.", "error");
      target.closest("[data-stage-row]")?.remove();
      refreshStageRows();
      return;
    }
    if (target.hasAttribute("data-stage-up") || target.hasAttribute("data-stage-down")) {
      const row = target.closest("[data-stage-row]");
      const sibling = target.hasAttribute("data-stage-up") ? row?.previousElementSibling : row?.nextElementSibling;
      if (row && sibling) {
        if (target.hasAttribute("data-stage-up")) row.parentElement.insertBefore(row, sibling);
        else row.parentElement.insertBefore(sibling, row);
        refreshStageRows();
      }
      return;
    }
    if (target.hasAttribute("data-stage-approve")) return runAction(reviewStage(target.dataset.stageApprove, true));
    if (target.hasAttribute("data-stage-revise")) return runAction(reviewStage(target.dataset.stageRevise, false));
    if (target.hasAttribute("data-stage-save")) return runAction(saveStageSettings(target.dataset.stageSave));
    if (target.hasAttribute("data-workflow-toggle")) return runAction(toggleWorkflow(target.dataset.workflowToggle));
    if (target.hasAttribute("data-workflow-cancel")) return runAction(cancelWorkflow());
    if (target.hasAttribute("data-stage-order")) return runAction(reorderFutureStage(target.dataset.stageOrder, target.dataset.direction));
    if (target.hasAttribute("data-stage-delete")) return runAction(removeFutureStage(target.dataset.stageDelete));
  });
  panel.addEventListener("change", (event) => {
    if (event.target.matches("[data-stage-role]")) refreshStageRows();
    if (event.target.matches(".cross-work-add-stage-form [name=teamRole]")) {
      const select = event.target.closest("form")?.elements.assignees;
      if (select) select.innerHTML = rosterOptions(event.target.value);
    }
  });
  panel.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.matches("[data-stage-submit-form]")) {
      event.preventDefault();
      return runAction(submitStage(form.dataset.stageSubmitForm, form.querySelector("[data-handover-note]")?.value));
    }
    if (form.matches("[data-stage-link-form]")) {
      event.preventDefault();
      return runAction(addLink(form.dataset.stageLinkForm, form.elements.label.value, form.elements.url.value));
    }
    if (form.matches("[data-stage-comment-form]")) {
      event.preventDefault();
      const stageId = form.dataset.stageCommentForm;
      const text = form.elements.text.value;
      return runAction(addComment(stageId, text));
    }
    if (form.matches(".cross-work-deadline-form")) {
      event.preventDefault();
      return runAction(setOverallDeadline(form));
    }
    if (form.matches(".cross-work-add-stage-form")) {
      event.preventDefault();
      return runAction(addFutureStage(form));
    }
  });
  document.getElementById("crossTeamSearch")?.addEventListener("input", renderList);
  document.getElementById("crossTeamStatusFilter")?.addEventListener("change", renderList);
  createForm?.addEventListener("change", (event) => {
    if (event.target.matches("[data-stage-role]")) refreshStageRows();
  });
  refreshStageRows();

  return {
    load,
    refresh: () => {
      activeMembers = [];
      void loadRoster();
      renderList();
    },
    reset: () => {
      workflows = [];
      selectedId = "";
      selectedWorkflow = null;
      selectedStages = [];
      activeMembers = [];
      if (listRoot) listRoot.innerHTML = `<div class="empty-state">Sign in to view your team’s shared work.</div>`;
      detailRoot?.classList.add("hidden");
    }
  };
}
