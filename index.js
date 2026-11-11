"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { initializeApp, getApps } = require("firebase-admin/app");

if (!getApps().length) initializeApp();

const db = getFirestore();
const auth = getAuth();
const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const BATCH_SIZE = 400;

function requireAdmin(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in with an Admin account.");
}

async function removeQuery(query) {
  const snapshot = await query.get();
  for (let offset = 0; offset < snapshot.docs.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    snapshot.docs.slice(offset, offset + BATCH_SIZE).forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }
  return snapshot.size;
}

async function deleteTaskSubmissions(uid) {
  const snapshot = await db.collectionGroup("submissions").where("submitterUid", "==", uid).get();
  let deleted = 0;
  for (const submission of snapshot.docs) {
    const taskRef = submission.ref.parent.parent;
    if (!taskRef) continue;
    const removed = await db.runTransaction(async (transaction) => {
      const [submissionSnapshot, taskSnapshot] = await Promise.all([
        transaction.get(submission.ref),
        transaction.get(taskRef)
      ]);
      if (!submissionSnapshot.exists) return false;
      if (taskSnapshot.exists) {
        const task = taskSnapshot.data();
        const count = Math.max(0, Number(task.submissionCount) || 0);
        const update = {
          submissionCount: Math.max(0, count - 1),
          updatedAt: FieldValue.serverTimestamp()
        };
        if (task.claimedByUid === uid) {
          update.claimedByUid = "";
          if (task.status === "claimed") update.status = "open";
        }
        transaction.update(taskRef, update);
      }
      transaction.delete(submission.ref);
      return true;
    });
    if (removed) deleted += 1;
  }
  return deleted;
}

async function cleanQuestions(uid) {
  const [owned, answered] = await Promise.all([
    db.collection("questions").where("ownerUid", "==", uid).get(),
    db.collection("questions").where("answeredByUid", "==", uid).get()
  ]);
  const rows = new Map();
  for (const item of [...owned.docs, ...answered.docs]) rows.set(item.id, item);
  const docs = [...rows.values()];
  let deleted = 0;
  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    for (const item of docs.slice(offset, offset + BATCH_SIZE)) {
      const data = item.data();
      if (data.ownerUid === uid && data.status !== "answered") {
        batch.delete(item.ref);
        deleted += 1;
      } else {
        const update = {};
        if (data.ownerUid === uid) update.ownerUid = "";
        if (data.answeredByUid === uid) {
          update.answeredByUid = "";
          update.answeredByName = "Former member";
          update.answeredByPhotoURL = "";
        }
        batch.update(item.ref, update);
      }
    }
    await batch.commit();
  }
  return deleted;
}

async function deleteLeaderChats(uid) {
  const [memberChats, leaderChats] = await Promise.all([
    db.collection("leaderChats").where("memberUid", "==", uid).get(),
    db.collection("leaderChats").where("leaderUid", "==", uid).get()
  ]);
  const refs = new Map();
  for (const chat of [...memberChats.docs, ...leaderChats.docs]) refs.set(chat.ref.path, chat.ref);
  for (const ref of refs.values()) await db.recursiveDelete(ref);
  return refs.size;
}

async function removeUserFromSessions(uid) {
  const [targeted, created] = await Promise.all([
    db.collection("nawrasOnlineSessions").where("targetMemberUids", "array-contains", uid).get(),
    db.collection("nawrasOnlineSessions").where("createdBy", "==", uid).get()
  ]);
  const sessions = new Map();
  for (const item of [...targeted.docs, ...created.docs]) sessions.set(item.id, item);
  const docs = [...sessions.values()];
  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    for (const item of docs.slice(offset, offset + BATCH_SIZE)) {
      const session = item.data();
      const targetMemberUids = (Array.isArray(session.targetMemberUids) ? session.targetMemberUids : [])
        .filter((targetUid) => targetUid !== uid);
      const update = { updatedAt: FieldValue.serverTimestamp() };
      if (session.targetMemberUids?.includes(uid)) {
        update.targetMemberUids = targetMemberUids;
        if (session.audienceRole === "targeted" && targetMemberUids.length === 0) update.status = "cancelled";
      }
      if (session.createdBy === uid) update.createdByName = "Former member";
      batch.update(item.ref, update);
    }
    await batch.commit();
  }
  return docs.length;
}

exports.deleteAcademyUser = onCall(
  { region: "us-central1", timeoutSeconds: 540, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    requireAdmin(request);
    const adminUid = request.auth.uid;
    const uid = request.data?.uid;
    if (typeof uid !== "string" || !uidPattern.test(uid)) {
      throw new HttpsError("invalid-argument", "Choose a valid member account.");
    }
    if (uid === adminUid) throw new HttpsError("failed-precondition", "You cannot delete the signed-in Admin account.");

    const memberRef = db.collection("teamMembers").doc(uid);
    const profile = await db.runTransaction(async (transaction) => {
      const [adminSnapshot, targetSnapshot] = await Promise.all([
        transaction.get(db.collection("teamMembers").doc(adminUid)),
        transaction.get(memberRef)
      ]);
      if (!adminSnapshot.exists || adminSnapshot.data().active !== true || adminSnapshot.data().role !== "admin") {
        throw new HttpsError("permission-denied", "Only an active Admin can delete accounts.");
      }
      if (!targetSnapshot.exists) throw new HttpsError("not-found", "That team member was not found.");
      const target = targetSnapshot.data();
      if (target.role === "admin") throw new HttpsError("failed-precondition", "Admin accounts cannot be deleted from team management.");
      if (target.active !== true && target.deletionStatus !== "pending") {
        throw new HttpsError("failed-precondition", "This member is inactive and has no pending deletion to resume.");
      }
      // Retain only a UID tombstone: an old, not-yet-expired ID token must not
      // recreate the deleted profile through the public signup rule.
      transaction.set(db.collection("deletedAccounts").doc(uid), {
        deletedBy: adminUid, deletedAt: FieldValue.serverTimestamp()
      });
      if (target.deletionStatus !== "pending") {
        transaction.update(memberRef, {
          active: false,
          deletionStatus: "pending",
          deletionRequestedBy: adminUid,
          deletionRequestedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      return target;
    });

    // Keep a disabled profile until cleanup succeeds so a transient failure is
    // retryable from the Admin dashboard. Shared learning content is retained.
    try {
      await auth.deleteUser(uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw new HttpsError("unavailable", "The account is disabled, but its sign-in record could not yet be removed. Retry the deletion.");
      }
    }

    const [deletedGrants, deletedQuestions, deletedNotices,
      deletedVisits, deletedHands, deletedAttendance, deletedTaskSubmissions, deletedChats,
      deletedCourseAssignments, updatedSessions] = await Promise.all([
      removeQuery(db.collection("dashboardAccessGrants").where("scopeType", "==", "user").where("scopeTarget", "==", uid)),
      cleanQuestions(uid),
      removeQuery(db.collectionGroup("notifications").where("actorUid", "==", uid)),
      removeQuery(db.collectionGroup("attendanceVisits").where("uid", "==", uid)),
      removeQuery(db.collectionGroup("hands").where("uid", "==", uid)),
      removeQuery(db.collectionGroup("attendance").where("uid", "==", uid)),
      deleteTaskSubmissions(uid),
      deleteLeaderChats(uid),
      removeQuery(db.collection("courseAssignments").where("memberUid", "==", uid)),
      removeUserFromSessions(uid)
    ]);

    const ratingsRef = db.collection("memberRatings").doc(uid);
    const ratingsSnapshot = await ratingsRef.get();
    if (ratingsSnapshot.exists) await ratingsRef.delete();
    await db.recursiveDelete(memberRef);

    return {
      deleted: true,
      displayName: String(profile.displayName || "").slice(0, 80),
      removed: {
        dashboardGrants: deletedGrants,
        questions: deletedQuestions,
        notifications: deletedNotices,
        sessionVisits: deletedVisits,
        raisedHands: deletedHands,
        attendanceOverrides: deletedAttendance,
        taskSubmissions: deletedTaskSubmissions,
        chats: deletedChats,
        courseAssignments: deletedCourseAssignments,
        sessionsUpdated: updatedSessions,
        ratingSheet: ratingsSnapshot.exists
      }
    };
  }
);
