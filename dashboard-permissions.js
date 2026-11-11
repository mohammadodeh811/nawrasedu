import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const teams = [
  ["user", "User"], ["leaders", "Leaders"], ["public", "Public"], ["tech", "Technical"],
  ["social", "Social"], ["designers", "Designers"], ["content", "Content"], ["event", "Event"]
];

export function resourceCapability(role, action = "Read") {
  return `${role === "designers" ? "designerResources" : `resources_${role}`}${action}`;
}

export const PERMISSION_GROUPS = [
  { title: "Forms", items: [["formsRead", "View all forms"], ["formsManage", "Create, edit & delete forms"], ["formsResponses", "View & export submissions"]] },
  { title: "Courses", items: [["coursesRead", "View courses & private lessons"], ["coursesManage", "Create, edit, assign & delete courses"]] },
  { title: "Tasks", items: [["tasksRead", "View all tasks & submissions"], ["tasksManage", "Create, edit, review & delete tasks · award task XP"]] },
  { title: "Questions", items: [["questionsRead", "View all questions"], ["questionsManage", "Answer & delete questions"]] },
  { title: "Team", items: [["teamRead", "View member roster"], ["membersManage", "Assign non-admin roles, universities & leader positions"], ["xpManage", "Add or subtract member XP"], ["ratingsRead", "View member rating sheets"], ["ratingsManage", "Edit member rating sheets"]] },
  { title: "Sessions & attendance", items: [["sessionsRead", "View sessions for your role"], ["sessionsManage", "Create & manage sessions for your role"], ["attendanceRead", "View & export your role's attendance"], ["attendanceManage", "Edit your role's attendance"]] },
  { title: "Technical materials", items: [["technicalMaterialsRead", "View & preview materials"], ["technicalMaterialsManage", "Add, edit & delete materials"]] },
  ...teams.map(([role, label]) => ({
    title: `${label} resources`,
    items: [[resourceCapability(role), "View library"], [resourceCapability(role, "Manage"), "Add, edit & delete resources"]]
  })),
  { title: "Bulk resets", sensitive: true, items: [["xpReset", "Reset other non-admin members’ XP"], ["ratingsReset", "Clear other non-admin members’ ratings & notes"]] }
];

export const DASHBOARD_ACCESS_CAPABILITIES = PERMISSION_GROUPS.flatMap((group) => group.items.map(([key]) => key));
const labels = Object.fromEntries(PERMISSION_GROUPS.flatMap((group) => group.items.map(([key, label]) => [key, `${group.title} · ${label}`])));
export function dashboardCapabilityLabel(key) { return labels[key] || key; }

const parents = {
  formsRead: ["formsManage", "formsResponses"], formsResponses: ["formsManage"],
  coursesRead: ["coursesManage"], tasksRead: ["tasksManage"], questionsRead: ["questionsManage"],
  attendanceRead: ["attendanceManage"], sessionsRead: ["sessionsManage", "attendanceRead", "attendanceManage"],
  ratingsRead: ["ratingsManage", "ratingsReset"],
  teamRead: ["membersManage", "xpManage", "xpReset", "ratingsRead", "ratingsManage", "ratingsReset", "attendanceRead", "attendanceManage", "tasksManage", "coursesManage"]
};
for (const [role] of teams) parents[resourceCapability(role)] = [resourceCapability(role, "Manage")];
parents.technicalMaterialsRead = ["technicalMaterialsManage"];

export function hasCapability(grants, key) {
  return Boolean(grants?.[key] || parents[key]?.some((parent) => grants?.[parent]));
}

export function expandCapabilities(keys) {
  const expanded = new Set(keys);
  let previousSize;
  do {
    previousSize = expanded.size;
    const grants = Object.fromEntries([...expanded].map((key) => [key, true]));
    for (const key of DASHBOARD_ACCESS_CAPABILITIES) if (hasCapability(grants, key)) expanded.add(key);
  } while (expanded.size !== previousSize);
  return [...expanded];
}

// Three scoped queries instead of one request per permission.
// A role/university grant always uses the member's actual account metadata.
export async function loadMemberCapabilities(db, member, onError = () => {}) {
  if (!member?.uid || member.active !== true) return {};
  if (member.role === "admin") return Object.fromEntries(DASHBOARD_ACCESS_CAPABILITIES.map((key) => [key, true]));
  const targets = [["user", member.uid], ["role", member.role], ["university", member.universityTag]].filter(([, target]) => target);
  const results = await Promise.all(targets.map(async ([scopeType, scopeTarget]) => {
    try {
      const snapshot = await getDocs(query(collection(db, "dashboardAccessGrants"),
        where("scopeType", "==", scopeType), where("scopeTarget", "==", scopeTarget), where("active", "==", true)));
      return snapshot.docs.map((item) => item.data()).filter((grant) => grant.active === true
        && grant.scopeType === scopeType && grant.scopeTarget === scopeTarget
        && DASHBOARD_ACCESS_CAPABILITIES.includes(grant.capability));
    } catch (error) {
      onError(error);
      return [];
    }
  }));
  return Object.fromEntries(results.flat().map((grant) => [grant.capability, true]));
}
