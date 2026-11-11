const ROLE_KEYS = new Set(["user", "leaders", "public", "tech", "social", "designers", "content", "event"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PROFILE_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_STICKER_BYTES = 5 * 1024 * 1024;
const MAX_TASK_COVER_BYTES = 10 * 1024 * 1024;
const SAFE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf", "text/plain", "text/csv",
  "application/rtf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
const DOC_COLLECTIONS = new Set(["roleResources", "technicalMaterials", "coursePrivate", "tasks"]);
const utf8 = new TextEncoder();

let cachedGoogleToken = "";
let cachedGoogleTokenUntil = 0;
let cachedDriveFolderId = "";

function replyJson(body, status, origin, env, headers = {}) {
  const allowed = parseOrigins(env.WORKER_ALLOWED_ORIGINS);
  const corsOrigin = allowed.includes(origin) ? origin : "null";
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Nawras-Metadata, X-File-Name, Range",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function parseOrigins(value) {
  return String(value || "").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, val]) => [key, decodeFirestoreValue(val)]));
  if ("nullValue" in value) return null;
  return null;
}

function decodeFirestoreDocument(document) {
  return Object.fromEntries(Object.entries(document?.fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function firebaseApiBase(env) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_WEB_API_KEY) throw new Error("Drive backend is missing Firebase configuration.");
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
}

async function signedInMember(idToken, env) {
  const lookup = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!lookup.ok) throw new HttpError(401, "Your sign-in expired. Sign in again.");
  const lookupBody = await lookup.json();
  const identity = lookupBody.users?.[0];
  if (!identity?.localId || identity.disabled === true) throw new HttpError(401, "This account is not active.");

  const profileResponse = await fetch(`${firebaseApiBase(env)}/teamMembers/${encodeURIComponent(identity.localId)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!profileResponse.ok) throw new HttpError(403, "Your NAWRAS EDU profile is not available.");
  const member = decodeFirestoreDocument(await profileResponse.json());
  if (member.active !== true) throw new HttpError(403, "This account is inactive.");
  // The authenticated document path is authoritative. Older member records
  // do not always duplicate that ID in a uid field.
  return { uid: identity.localId, member: { ...member, uid: identity.localId }, idToken };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readGrant(id, bearer, env) {
  const response = await fetch(`${firebaseApiBase(env)}/dashboardAccessGrants/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${bearer}` }
  });
  if (response.status === 404 || response.status === 403) return false;
  if (!response.ok) throw new HttpError(503, "Could not verify dashboard permissions.");
  const grant = decodeFirestoreDocument(await response.json());
  return grant.active === true;
}

async function hasCapability(context, capability, env) {
  if (context.member.role === "admin") return true;
  const targets = [
    ["user", context.uid],
    ["role", context.member.role],
    ["university", context.member.universityTag]
  ].filter(([, target]) => typeof target === "string" && target.length);
  const grants = await Promise.all(targets.map(([scope, target]) =>
    readGrant(`${scope}_${target}_${capability}`, context.idToken, env)));
  return grants.some(Boolean);
}

function canManageTeamRole(context, role) {
  return context.member.role === "admin"
    || (Array.isArray(context.member.teamLeadRoles) && context.member.teamLeadRoles.includes(role));
}

async function canUpload(context, metadata, env) {
  if (metadata.category === "profile") return true;
  if (metadata.category === "profileSticker") {
    return metadata.sourceId === context.uid;
  }
  if (metadata.category === "roleResource") {
    const role = metadata.targetRole;
    if (!ROLE_KEYS.has(role)) return false;
    return canManageTeamRole(context, role)
      || await hasCapability(context, `${role === "designers" ? "designerResources" : `resources_${role}`}Manage`, env);
  }
  if (metadata.category === "technicalMaterial") {
    return canManageTeamRole(context, "tech")
      || await hasCapability(context, "technicalMaterialsManage", env);
  }
  if (metadata.category === "courseAsset") {
    return ["admin", "tech"].includes(context.member.role)
      || await hasCapability(context, "coursesManage", env);
  }
  if (metadata.category === "taskCover") {
    let task;
    try { task = await getFirestoreSource("taskCover", metadata.sourceId, context.idToken, env); }
    catch (_) { return false; }
    const targetRole = task.targetRole || "";
    if (metadata.targetRole !== targetRole) return false;
    if (context.member.role === "admin") return true;
    if (context.member.role === "leaders") {
      const universityTag = context.member.leadingUniversityTag || context.member.universityTag || "";
      const teamLeadRoles = Array.isArray(context.member.teamLeadRoles) ? context.member.teamLeadRoles : [];
      return (task.createdBy === context.uid && task.targetUniversityTag === universityTag)
        || (teamLeadRoles.includes(targetRole)
          && (!universityTag || task.targetUniversityTag === universityTag));
    }
    const teamLeadRoles = Array.isArray(context.member.teamLeadRoles) ? context.member.teamLeadRoles : [];
    if (targetRole !== "position_leaders" && teamLeadRoles.includes(targetRole)) return true;
    return targetRole !== "position_leaders"
      && await hasCapability(context, "tasksManage", env)
      && (targetRole === context.member.role || teamLeadRoles.includes(targetRole));
  }
  return false;
}

function decodeFileName(request) {
  const raw = request.headers.get("X-File-Name") || "upload";
  try { return decodeURIComponent(raw).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "upload"; }
  catch (_) { return "upload"; }
}

function safeMetadata(request) {
  let metadata;
  try { metadata = JSON.parse(request.headers.get("X-Nawras-Metadata") || "{}"); }
  catch (_) { throw new HttpError(400, "Upload details were invalid."); }
  if (!["profile", "profileSticker", "roleResource", "technicalMaterial", "courseAsset", "taskCover"].includes(metadata.category)) {
    throw new HttpError(400, "Choose a supported upload destination.");
  }
  if (["roleResource", "technicalMaterial"].includes(metadata.category)
    && metadata.targetRole && !ROLE_KEYS.has(metadata.targetRole)) {
    throw new HttpError(400, "The selected team is not supported.");
  }
  if (metadata.category !== "profile" && !/^[A-Za-z0-9_-]{1,150}$/.test(metadata.sourceId || "")) {
    throw new HttpError(400, "Save the resource before uploading its file.");
  }
  if (metadata.category === "profileSticker" && !/^[A-Za-z0-9_-]{1,128}$/.test(metadata.sourceId || "")) {
    throw new HttpError(400, "The profile sticker owner is invalid.");
  }
  if (metadata.category === "roleResource" && !ROLE_KEYS.has(metadata.targetRole || "")) {
    throw new HttpError(400, "Select a valid team for this resource.");
  }
  if (metadata.category === "technicalMaterial" && metadata.targetRole !== "tech") {
    throw new HttpError(400, "Technical materials must belong to the Technical team.");
  }
  if (metadata.category === "courseAsset" && !/^[A-Za-z0-9_-]{1,150}$/.test(metadata.sourceId || "")) {
    throw new HttpError(400, "Save the course before uploading its lesson files.");
  }
  if (metadata.category === "taskCover" && !/^[A-Za-z0-9_-]{1,150}$/.test(metadata.sourceId || "")) {
    throw new HttpError(400, "Save the task before uploading its photo.");
  }
  if (metadata.category === "taskCover"
    && !ROLE_KEYS.has(metadata.targetRole || "")
    && !["admin", "position_leaders"].includes(metadata.targetRole || "")) {
    throw new HttpError(400, "The task audience is not supported for this photo.");
  }
  return metadata;
}

async function googleAccessToken(env) {
  if (cachedGoogleToken && cachedGoogleTokenUntil > Date.now() + 60_000) return cachedGoogleToken;
  const required = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN"];
  if (required.some((key) => !env[key])) throw new HttpError(503, "Google Drive is not configured on the backend yet.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) throw new HttpError(503, "Google Drive authorization needs to be reconnected.");
  cachedGoogleToken = result.access_token;
  cachedGoogleTokenUntil = Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000;
  return cachedGoogleToken;
}

async function driveFetch(path, token, options = {}) {
  return fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
}

async function driveFolderId(token) {
  if (cachedDriveFolderId) return cachedDriveFolderId;
  const query = encodeURIComponent("name='NAWRAS EDU uploads' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const found = await driveFetch(`/drive/v3/files?q=${query}&pageSize=10&fields=files(id,appProperties)`, token);
  if (!found.ok) throw new HttpError(502, "Google Drive could not open the Academy storage folder.");
  const folders = (await found.json()).files || [];
  const existing = folders.find((folder) => folder.appProperties?.app === "nawras-edu" && folder.appProperties?.category === "folder");
  if (existing?.id) return cachedDriveFolderId = existing.id;
  const created = await driveFetch("/drive/v3/files?fields=id", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "NAWRAS EDU uploads",
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { app: "nawras-edu", category: "folder" }
    })
  });
  if (!created.ok) throw new HttpError(502, "Google Drive could not create the Academy storage folder.");
  const folder = await created.json();
  if (!folder.id) throw new HttpError(502, "Google Drive returned no storage folder ID.");
  return cachedDriveFolderId = folder.id;
}

function driveAppProperties(context, metadata) {
  const properties = {
    app: "nawras-edu",
    category: metadata.category,
    ownerUid: context.uid
  };
  if (metadata.targetRole) properties.targetRole = metadata.targetRole;
  if (metadata.sourceId) properties.sourceId = metadata.sourceId;
  return properties;
}

async function uploadFile(request, env, origin, context) {
  const metadata = safeMetadata(request);
  if (!await canUpload(context, metadata, env)) throw new HttpError(403, "You do not have permission to upload to this library.");
  const mimeType = (request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (!SAFE_TYPES.has(mimeType)) throw new HttpError(415, "This file type is not supported.");
  const sizeBytes = Number(request.headers.get("Content-Length") || metadata.sizeBytes || 0);
  const maxBytes = metadata.category === "profile" ? MAX_PROFILE_BYTES
    : metadata.category === "profileSticker" ? MAX_PROFILE_STICKER_BYTES
    : metadata.category === "taskCover" ? MAX_TASK_COVER_BYTES : MAX_FILE_BYTES;
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) {
    throw new HttpError(413, metadata.category === "profileSticker"
      ? "Profile stickers must be 5 MB or smaller."
      : ["profile", "taskCover"].includes(metadata.category) ? "Photos must be 10 MB or smaller." : "Files must be 50 MB or smaller.");
  }
  if (!request.body) throw new HttpError(400, "The selected file was empty.");
  if (metadata.category === "profile" && !mimeType.startsWith("image/")) {
    throw new HttpError(415, "Profile photos must be JPG, PNG, or WebP images.");
  }
  if (metadata.category === "profileSticker" && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    throw new HttpError(415, "Profile stickers must be PNG, WebP, GIF, or JPEG images.");
  }
  if (metadata.category === "taskCover" && !["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    throw new HttpError(415, "Task photos must be JPG, PNG, or WebP images.");
  }
  if (metadata.category === "courseAsset" && !metadata.sourceId) {
    throw new HttpError(400, "Save the course before uploading its lesson files.");
  }
  if (["roleResource", "technicalMaterial"].includes(metadata.category) && !metadata.targetRole) {
    throw new HttpError(400, "Select the team that will receive this resource.");
  }

  const driveToken = await googleAccessToken(env);
  const folderId = await driveFolderId(driveToken);
  const fileName = decodeFileName(request);
  const fileMetadata = {
    name: fileName,
    mimeType,
    parents: [folderId],
    appProperties: driveAppProperties(context, metadata)
  };
  const init = await driveFetch("/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,parents,appProperties", driveToken, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(sizeBytes)
    },
    body: JSON.stringify(fileMetadata)
  });
  if (!init.ok) throw new HttpError(502, "Google Drive could not start the upload.");
  const sessionUrl = init.headers.get("Location");
  if (!sessionUrl || !sessionUrl.startsWith("https://www.googleapis.com/upload/drive/")) {
    throw new HttpError(502, "Google Drive returned an invalid upload session.");
  }
  const uploaded = await fetch(sessionUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "Content-Length": String(sizeBytes) },
    body: request.body
  });
  const file = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !file.id) throw new HttpError(502, "The file did not finish uploading to Google Drive.");

  let publicUrl = "";
  if (metadata.category === "profile") {
    const permission = await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}/permissions?fields=id`, driveToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader", allowFileDiscovery: false })
    });
    if (!permission.ok) {
      await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}`, driveToken, { method: "DELETE" }).catch(() => {});
      throw new HttpError(502, "The profile image uploaded, but Drive could not make that single image viewable.");
    }
    publicUrl = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(file.id)}`;
  }
  return replyJson({
    id: file.id,
    fileName: file.name || fileName,
    mimeType: file.mimeType || mimeType,
    sizeBytes: Number(file.size) || sizeBytes,
    category: metadata.category,
    targetRole: metadata.targetRole || "",
    uploadedByUid: context.uid,
    uploadedAt: new Date().toISOString(),
    publicUrl
  }, 201, origin, env);
}

function sourceFileId(sourceType, source) {
  if (sourceType === "courseAsset" && Array.isArray(source.assets)) {
    const asset = source.assets.find((item) => item?.driveFileId);
    return asset?.driveFileId || "";
  }
  if (sourceType === "taskCover") return source.coverDriveFileId || "";
  return source.driveFileId || "";
}

async function getFirestoreSource(sourceType, sourceId, idToken, env) {
  const collection = {
    roleResource: "roleResources",
    technicalMaterial: "technicalMaterials",
    courseAsset: "coursePrivate",
    taskCover: "tasks"
  }[sourceType];
  if (!collection || !/^[A-Za-z0-9_-]{1,150}$/.test(sourceId || "")) throw new HttpError(400, "That resource reference is invalid.");
  const response = await fetch(`${firebaseApiBase(env)}/${collection}/${encodeURIComponent(sourceId)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!response.ok) throw new HttpError(403, "You do not have access to this resource.");
  return decodeFirestoreDocument(await response.json());
}

async function ticketKey(env) {
  if (!env.MEDIA_TICKET_SECRET || env.MEDIA_TICKET_SECRET.length < 32) {
    throw new HttpError(503, "The secure preview service is not configured yet.");
  }
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(env.MEDIA_TICKET_SECRET));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function encryptTicket(claims, env) {
  const key = await ticketKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8.encode(JSON.stringify(claims)));
  return base64url(new Uint8Array([...iv, ...new Uint8Array(cipher)]));
}

async function decryptTicket(ticket, env) {
  try {
    const bytes = fromBase64url(ticket);
    if (bytes.length < 29 || bytes.length > 8192) throw new Error();
    const key = await ticketKey(env);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "This preview link is invalid or expired. Open the resource again.");
  }
}

async function createPreviewTicket(request, env, origin, context) {
  const body = await request.json().catch(() => ({}));
  const sourceType = body.sourceType;
  const sourceId = body.sourceId;
  const requestedFileId = body.fileId;
  if (!DOC_COLLECTIONS.has({
    roleResource: "roleResources",
    technicalMaterial: "technicalMaterials",
    courseAsset: "coursePrivate",
    taskCover: "tasks"
  }[sourceType])) throw new HttpError(400, "That preview type is not supported.");
  const source = await getFirestoreSource(sourceType, sourceId, context.idToken, env);
  let fileId = sourceFileId(sourceType, source);
  let fileMeta = source;
  if (sourceType === "courseAsset" && requestedFileId) {
    fileMeta = source.assets?.find((asset) => asset?.driveFileId === requestedFileId) || {};
    fileId = fileMeta.driveFileId || "";
  }
  if (!fileId || (requestedFileId && fileId !== requestedFileId)) {
    throw new HttpError(404, "This Drive file is no longer attached to the resource.");
  }
  const expectedCategory = {
    roleResource: "roleResource",
    technicalMaterial: "technicalMaterial",
    courseAsset: "courseAsset",
    taskCover: "taskCover"
  }[sourceType];
  const ticket = await encryptTicket({
    uid: context.uid,
    idToken: context.idToken,
    sourceType, sourceId, fileId,
    expectedCategory,
    targetRole: fileMeta.targetRole || source.targetRole || (sourceType === "technicalMaterial" ? "tech" : ""),
    exp: Math.floor(Date.now() / 1000) + 3600
  }, env);
  return replyJson({
    url: `${new URL(request.url).origin}/v1/media?ticket=${encodeURIComponent(ticket)}`,
    fileName: fileMeta.driveFileName || "Academy resource",
    mimeType: fileMeta.driveMimeType || "application/octet-stream",
    sizeBytes: Number(fileMeta.driveSizeBytes) || 0
  }, 200, origin, env);
}

function driveFileMetadataPath(id) {
  return `/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,parents,appProperties,webViewLink`;
}

async function streamDriveMedia(request, env, origin) {
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (!ticket) throw new HttpError(401, "Open this resource from your signed-in dashboard.");
  const claims = await decryptTicket(ticket, env);
  if (!claims.uid || !claims.idToken || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "This preview link expired. Open the resource again.");
  }
  const context = await signedInMember(claims.idToken, env);
  if (context.uid !== claims.uid) throw new HttpError(403, "This preview belongs to another account.");
  const source = await getFirestoreSource(claims.sourceType, claims.sourceId, context.idToken, env);
  const sourceId = claims.sourceType === "courseAsset"
    ? source.assets?.find((asset) => asset?.driveFileId === claims.fileId)?.driveFileId
    : claims.sourceType === "taskCover" ? source.coverDriveFileId : source.driveFileId;
  if (!sourceId || sourceId !== claims.fileId) throw new HttpError(403, "You no longer have access to this file.");

  const token = await googleAccessToken(env);
  const metaResponse = await driveFetch(driveFileMetadataPath(claims.fileId), token);
  if (!metaResponse.ok) throw new HttpError(metaResponse.status === 404 ? 404 : 502, "The Drive file is unavailable.");
  const file = await metaResponse.json();
  if (file.appProperties?.app !== "nawras-edu"
    || file.appProperties?.category !== claims.expectedCategory
    || file.appProperties?.sourceId !== claims.sourceId
    || (!["courseAsset", "taskCover"].includes(claims.expectedCategory)
      && file.appProperties?.targetRole !== claims.targetRole)
    || !file.parents?.includes(await driveFolderId(token))) {
    throw new HttpError(403, "This file is outside the Academy storage folder.");
  }

  const isGoogleDoc = String(file.mimeType || "").startsWith("application/vnd.google-apps.");
  let path = isGoogleDoc
    ? `/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=application/pdf`
    : `/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
  const headers = {};
  if (!isGoogleDoc && request.headers.has("Range")) headers.Range = request.headers.get("Range");
  const media = await driveFetch(path, token, { headers });
  if (!media.ok) throw new HttpError(media.status === 416 ? 416 : 502, "Google Drive could not preview this file.");
  const contentType = isGoogleDoc ? "application/pdf" : file.mimeType || "application/octet-stream";
  const outHeaders = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": contentType.startsWith("image/") || contentType.startsWith("video/") || contentType === "application/pdf"
      ? `inline; filename*=UTF-8''${encodeURIComponent(file.name || "resource")}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(file.name || "download")}`,
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": media.headers.get("Accept-Ranges") || "bytes",
    "Access-Control-Allow-Origin": origin && parseOrigins(env.WORKER_ALLOWED_ORIGINS).includes(origin) ? origin : "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Vary": "Origin"
  });
  for (const name of ["Content-Length", "Content-Range"]) {
    const value = media.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  return new Response(media.body, { status: media.status, headers: outHeaders });
}

async function deleteOldProfilePhoto(request, env, origin, context) {
  const body = await request.json().catch(() => ({}));
  const fileId = String(body.fileId || "");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new HttpError(400, "The old photo reference is invalid.");
  const profile = context.member;
  if (profile.photoDriveFileId === fileId) {
    throw new HttpError(409, "The profile still uses this photo, so it was not deleted.");
  }
  const token = await googleAccessToken(env);
  const response = await driveFetch(driveFileMetadataPath(fileId), token);
  if (response.status === 404) return replyJson({ deleted: true }, 200, origin, env);
  if (!response.ok) throw new HttpError(502, "Could not check the previous profile photo.");
  const file = await response.json();
  if (file.appProperties?.app !== "nawras-edu"
    || file.appProperties?.category !== "profile"
    || file.appProperties?.ownerUid !== context.uid
    || !file.parents?.includes(await driveFolderId(token))) {
    throw new HttpError(403, "You cannot remove that Drive file.");
  }
  const deleted = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}`, token, { method: "DELETE" });
  if (!deleted.ok && deleted.status !== 404) throw new HttpError(502, "The previous profile photo could not be removed.");
  return replyJson({ deleted: true }, 200, origin, env);
}

async function deleteOwnedProfileSticker(request, env, origin, context) {
  const body = await request.json().catch(() => ({}));
  const fileId = String(body.fileId || "");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new HttpError(400, "The sticker reference is invalid.");
  const token = await googleAccessToken(env);
  const response = await driveFetch(driveFileMetadataPath(fileId), token);
  if (response.status === 404) return replyJson({ deleted: true }, 200, origin, env);
  if (!response.ok) throw new HttpError(502, "Could not check the Drive sticker.");
  const file = await response.json();
  if (file.appProperties?.app !== "nawras-edu"
    || file.appProperties?.category !== "profileSticker"
    || file.appProperties?.ownerUid !== context.uid
    || file.appProperties?.sourceId !== context.uid
    || !file.parents?.includes(await driveFolderId(token))) {
    throw new HttpError(403, "You can only delete stickers uploaded to your own profile.");
  }
  const deleted = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}`, token, { method: "DELETE" });
  if (!deleted.ok && deleted.status !== 404) throw new HttpError(502, "The Drive sticker could not be deleted.");
  return replyJson({ deleted: true }, 200, origin, env);
}

async function streamProfilePhoto(fileId, env) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new HttpError(404, "Profile photo not found.");
  const token = await googleAccessToken(env);
  const metadata = await driveFetch(`${driveFileMetadataPath(fileId)},trashed,permissions(type,role)`, token);
  if (!metadata.ok) throw new HttpError(metadata.status === 404 ? 404 : 502, "Profile photo not available.");
  const file = await metadata.json();
  // This public route must never expose private course or team resources.
  if (file.trashed || file.appProperties?.app !== "nawras-edu"
    || file.appProperties?.category !== "profile"
    || !["image/jpeg", "image/png", "image/webp"].includes(file.mimeType)
    || !(Number(file.size) > 0 && Number(file.size) <= MAX_PROFILE_BYTES)
    || !file.permissions?.some((permission) => permission.type === "anyone" && permission.role === "reader")
    || !file.parents?.includes(await driveFolderId(token))) {
    throw new HttpError(404, "Profile photo not found.");
  }
  const image = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, token);
  if (!image.ok) throw new HttpError(502, "Profile photo could not be loaded.");
  return new Response(image.body, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": "inline",
      // Profile-photo URLs include immutable Drive file IDs; edits upload a new ID.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function publicTeamMember(uid, env) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid || "")) throw new HttpError(404, "Profile sticker not found.");
  const url = `${firebaseApiBase(env)}/teamMembers/${encodeURIComponent(uid)}?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY || "")}`;
  const response = await fetch(url);
  if (!response.ok) throw new HttpError(404, "Profile sticker not found.");
  const member = decodeFirestoreDocument(await response.json());
  if (member.active !== true) throw new HttpError(404, "Profile sticker not found.");
  return member;
}

async function streamProfileSticker(uid, fileId, env, origin) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId || "")) throw new HttpError(404, "Profile sticker not found.");
  const member = await publicTeamMember(uid, env);
  const inventoryItem = (Array.isArray(member.publicProfileStickers) ? member.publicProfileStickers : [])
    .find((item) => item?.id === fileId);
  const placedOnProfile = (Array.isArray(member.publicProfileArt) ? member.publicProfileArt : [])
    .some((item) => item?.kind === "uploadedSticker" && item?.stickerId === fileId);
  if (!inventoryItem || !placedOnProfile) throw new HttpError(404, "Profile sticker not found.");

  return streamProfileStickerFile(uid, fileId, env, origin);
}

async function streamOwnedProfileStickerPreview(request, fileId, env, origin) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId || "")) throw new HttpError(404, "Profile sticker not found.");
  const authorization = request.headers.get("Authorization") || "";
  const idToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!idToken) throw new HttpError(401, "Sign in to preview your private sticker.");
  const context = await signedInMember(idToken, env);
  const inventoryItem = (Array.isArray(context.member.publicProfileStickers) ? context.member.publicProfileStickers : [])
    .find((item) => item?.id === fileId);
  if (!inventoryItem) throw new HttpError(404, "Profile sticker not found.");
  return streamProfileStickerFile(context.uid, fileId, env, origin);
}

async function streamProfileStickerFile(uid, fileId, env, origin) {
  const token = await googleAccessToken(env);
  const metadata = await driveFetch(`${driveFileMetadataPath(fileId)},trashed`, token);
  if (!metadata.ok) throw new HttpError(404, "Profile sticker not found.");
  const file = await metadata.json();
  if (file.trashed
    || file.appProperties?.app !== "nawras-edu"
    || file.appProperties?.category !== "profileSticker"
    || file.appProperties?.ownerUid !== uid
    || file.appProperties?.sourceId !== uid
    || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimeType)
    || !(Number(file.size) > 0 && Number(file.size) <= MAX_PROFILE_STICKER_BYTES)
    || !file.parents?.includes(await driveFolderId(token))) {
    throw new HttpError(404, "Profile sticker not found.");
  }
  const image = await driveFetch(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, token);
  if (!image.ok) throw new HttpError(502, "Profile sticker could not be loaded.");
  return new Response(image.body, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name || "sticker")}`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Access-Control-Allow-Origin": origin && parseOrigins(env.WORKER_ALLOWED_ORIGINS).includes(origin) ? origin : "*",
      "Vary": "Origin"
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseOrigins(env.WORKER_ALLOWED_ORIGINS);
    if (origin && !allowedOrigins.includes(origin)) {
      return replyJson({ error: "This website is not allowed to use the Drive service." }, 403, origin, env);
    }
    if (request.method === "OPTIONS") return replyJson({}, 204, origin, env);
    const url = new URL(request.url);
    const photoRoute = url.pathname.match(/^\/v1\/profile-photo\/([A-Za-z0-9_-]{10,200})$/);
    if (photoRoute && request.method === "GET") {
      try { return await streamProfilePhoto(photoRoute[1], env); }
      catch (error) {
        return replyJson({ error: error instanceof HttpError ? error.message : "The profile photo could not be loaded." },
          error instanceof HttpError ? error.status : 500, origin, env);
      }
    }
    const stickerRoute = url.pathname.match(/^\/v1\/profile-sticker\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{10,200})$/);
    if (stickerRoute && request.method === "GET") {
      try { return await streamProfileSticker(stickerRoute[1], stickerRoute[2], env, origin); }
      catch (error) {
        return replyJson({ error: error instanceof HttpError ? error.message : "The profile sticker could not be loaded." },
          error instanceof HttpError ? error.status : 500, origin, env);
      }
    }
    const stickerPreviewRoute = url.pathname.match(/^\/v1\/profile-sticker-preview\/([A-Za-z0-9_-]{10,200})$/);
    if (stickerPreviewRoute && request.method === "GET") {
      try { return await streamOwnedProfileStickerPreview(request, stickerPreviewRoute[1], env, origin); }
      catch (error) {
        return replyJson({ error: error instanceof HttpError ? error.message : "The private sticker preview could not be loaded." },
          error instanceof HttpError ? error.status : 500, origin, env);
      }
    }
    if (url.pathname === "/v1/media" && request.method === "GET") {
      try { return await streamDriveMedia(request, env, origin); }
      catch (error) {
        return replyJson({ error: error instanceof HttpError ? error.message : "The file could not be opened." },
          error instanceof HttpError ? error.status : 500, origin, env);
      }
    }
    if (!["POST", "DELETE"].includes(request.method)) return replyJson({ error: "Not found." }, 404, origin, env);
    if (!origin) return replyJson({ error: "The Drive service requires a website request." }, 403, origin, env);
    let context;
    try {
      const authorization = request.headers.get("Authorization") || "";
      const idToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!idToken) throw new HttpError(401, "Sign in before using Google Drive.");
      context = await signedInMember(idToken, env);
      if (url.pathname === "/v1/upload" && request.method === "POST") return await uploadFile(request, env, origin, context);
      if (url.pathname === "/v1/preview-ticket" && request.method === "POST") return await createPreviewTicket(request, env, origin, context);
      if (url.pathname === "/v1/profile-photo" && request.method === "DELETE") return await deleteOldProfilePhoto(request, env, origin, context);
      if (url.pathname === "/v1/profile-sticker" && request.method === "DELETE") return await deleteOwnedProfileSticker(request, env, origin, context);
      return replyJson({ error: "Not found." }, 404, origin, env);
    } catch (error) {
      return replyJson({ error: error instanceof HttpError ? error.message : "The Drive request could not be completed." },
        error instanceof HttpError ? error.status : 500, origin, env);
    }
  }
};
