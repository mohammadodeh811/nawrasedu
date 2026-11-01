/* Firebase Cloud Messaging service worker.
 * Keep this file at the website root, next to index.html.
 */
// OneSignal is combined with this root worker so it shares Firebase's scope.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDys7Ip19RFb0cTBgw8pbYpPLwbIUciBGY",
  authDomain: "nawrasedu-c21ba.firebaseapp.com",
  projectId: "nawrasedu-c21ba",
  storageBucket: "nawrasedu-c21ba.firebasestorage.app",
  messagingSenderId: "417514608389",
  appId: "1:417514608389:web:0941f111496dc06091c96c",
  measurementId: "G-M38KH6932C"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const title = data.title || "NAWRAS EDU";
  const body = data.body || "You have a new NAWRAS EDU update.";
  const url = data.url || "/admin.html";

  self.registration.showNotification(title, {
    body,
    icon: "https://nawrasedu.site.je/icoom.png",
    badge: "https://nawrasedu.site.je/icoom.png",
    tag: data.tag || "nawras-edu",
    data: { url, source: "firebase" }
  });
});

self.addEventListener("notificationclick", (event) => {
  if (event.notification.data?.source !== "firebase") return;
  event.notification.close();
  const url = event.notification.data?.url || "/admin.html";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ("focus" in client) {
        client.navigate(url);
        return client.focus();
      }
    }
    return clients.openWindow(url);
  }));
});