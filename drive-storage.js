import { DRIVE_API_BASE_URL } from "./drive-config.js";

export function isDriveStorageConfigured() {
  return /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/i.test(DRIVE_API_BASE_URL);
}

// Profile photos are public images; library/course files never use this route.
export function driveProfilePhotoUrl(fileId) {
  const id = String(fileId || "").trim();
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(id)) return "";
  return isDriveStorageConfigured()
    ? `${DRIVE_API_BASE_URL}/v1/profile-photo/${encodeURIComponent(id)}`
    : `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w640`;
}

export function driveProfileStickerUrl(fileId, uid) {
  const id = String(fileId || "").trim();
  const ownerUid = String(uid || "").trim();
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerUid)) return "";
  return isDriveStorageConfigured()
    ? `${DRIVE_API_BASE_URL.replace(/\/+$/, "")}/v1/profile-sticker/${encodeURIComponent(ownerUid)}/${encodeURIComponent(id)}`
    : "";
}

function endpoint(path) {
  if (!isDriveStorageConfigured()) {
    throw new Error("Google Drive is not connected yet. Finish the Drive setup steps first.");
  }
  return `${DRIVE_API_BASE_URL.replace(/\/+$/, "")}${path}`;
}

async function signedInToken(auth) {
  const user = auth?.currentUser;
  if (!user) throw new Error("Sign in before opening this file.");
  return user.getIdToken();
}

export async function uploadDriveFile(auth, file, metadata, { onProgress = () => {} } = {}) {
  if (!(file instanceof Blob)) throw new Error("Choose a valid file to upload.");
  const token = await signedInToken(auth);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint("/v1/upload"));
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Nawras-Metadata", JSON.stringify(metadata || {}));
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name || "upload"));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Could not reach the Google Drive upload service."));
    xhr.ontimeout = () => reject(new Error("The upload timed out. Try a smaller file or a steadier connection."));
    xhr.onload = () => {
      let result;
      try { result = JSON.parse(xhr.responseText || "{}"); } catch (_) { result = {}; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(result.error || `Upload failed (HTTP ${xhr.status}).`));
        return;
      }
      resolve(result);
    };
    xhr.timeout = 180000;
    xhr.send(file);
  });
}

export async function requestDrivePreviewTicket(auth, sourceType, sourceId, fileId) {
  const token = await signedInToken(auth);
  const response = await fetch(endpoint("/v1/preview-ticket"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sourceType, sourceId, fileId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.url) throw new Error(result.error || "This file could not be previewed.");
  return result;
}

export async function retireDriveProfilePhoto(auth, fileId) {
  if (!fileId || !isDriveStorageConfigured()) return;
  const token = await signedInToken(auth);
  const response = await fetch(endpoint("/v1/profile-photo"), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fileId })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "The new photo was saved, but the old Drive copy could not be removed.");
  }
}

export async function requestDriveProfileStickerPreview(auth, fileId) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(fileId || ""))) throw new Error("The sticker reference is invalid.");
  const token = await signedInToken(auth);
  const response = await fetch(endpoint(`/v1/profile-sticker-preview/${encodeURIComponent(fileId)}`), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "This private Drive sticker could not be previewed.");
  }
  const blob = await response.blob();
  if (!/^image\/(png|webp|gif|jpeg)$/.test(blob.type)) throw new Error("Drive returned an unsupported sticker image.");
  return URL.createObjectURL(blob);
}

export async function retireDriveProfileSticker(auth, fileId) {
  if (!fileId) return;
  if (!isDriveStorageConfigured()) throw new Error("The Google Drive worker is not connected, so the private copy could not be deleted.");
  const token = await signedInToken(auth);
  const response = await fetch(endpoint("/v1/profile-sticker"), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fileId })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "The sticker was removed from your profile, but the Drive copy could not be deleted.");
  }
}
