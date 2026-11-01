NAWRAS EDU — attendance tracking update

Replace the matching files in the existing site with the files in this folder.
All attached site and Firebase config files are included; the unmodified site
pages are copied unchanged.

Files changed:
- admin.html
- app.js
- nawras-online.js
- styles.css
- firestore.rules

Required deployment order:
1. Deploy firestore.rules before publishing the updated JavaScript. The new rules
   authorize account-owned visit creation/closure, admin-only attendance reads
   and admin-only status/note changes.
2. Publish the updated site files.

The uploaded snapshot did not include the existing Cloudflare room-token
worker or Firebase Functions source. This update does not change those services.

Behavior and source-data limits:
- Attendance tracks NawrasOnline video-room connections. It does not track
  external meeting links or recurring schedule cards that are not NawrasOnline
  rooms.
- The supplied app has no per-session RSVP list. For automatic absence, the
  roster is the active accounts matching that room's configured role and
  university audience. Unjoined accounts are shown as absent after a room ends;
  before then they remain "Not joined yet".
- Visit times are recorded by the participant's signed-in account. Email is
  captured for a participant who joins. Existing team-member profiles do not
  normally store email, so an absent person's email can only be shown when an
  email is already present in that profile.
- A normal leave, LiveKit disconnect, and page exit each attempt to save an exit
  time. A browser crash or loss of network at exit can prevent that final write;
  such a visit remains marked "Still open" until it can be closed.
- The Excel download is an Excel-compatible workbook (.xls) with Attendance
  Summary and Individual Visits sheets. Times include seconds, local timezone,
  and UTC timestamps.
