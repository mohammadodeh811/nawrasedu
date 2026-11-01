NAWRAS EDU — Dashboard access and targeted inbox update

Use these files on top of your existing website. Do not replace your Firebase
configuration, images, member-socials.js, task-assets.css, or other existing files.

DEPLOYMENT
1. Upload/replace admin.html, app.js, styles.css, nawras-online.html,
   nawras-online.js and schedule.html.
2. Upload BOTH new files beside app.js:
   personal-calendar.js and personal-calendar-core.js.
3. Publish firestore.rules in your Firebase project's Firestore Rules.
4. Deploy firestore.indexes.json (it preserves existing indexes and adds
   Technical-access and reviewer-recipient lookup indexes).
   Wait for any index builds to finish.
5. Hard-refresh the website and sign in again.

WHAT CHANGED
- Public schedule links are removed by the shared site script/styles. The former
  homepage schedule card now opens My calendar. Old schedule.html URLs redirect
  to the signed-in user's private calendar; no public schedule is shown there.
- The legacy schedule manager is retired. New sessions are created in
  NawrasOnline, not the old weekly schedule editor.
- Sessions appear automatically for the member's actual account role and the
  session's university audience, OR when that member is individually invited.
  Dashboard viewing permissions do not silently grant session attendance.
- Admins/leaders can search members and send individual invitations, including
  an "Invited members only" audience, when creating a session.
- Each member can create, edit and delete their own personal events.
- Done / Coming / Missed can be set manually. Automatic status changes to Missed
  after the end time (or when a session ends) unless the member has chosen an
  explicit status. This is a personal planning label, not official attendance.
- Removing a synced session only hides it for that person. Restore hidden
  sessions brings it back. It never cancels or edits the official session.
- Official timing/title updates, cancellations and deletions sync to matching
  calendars while the dashboard is open. The latest state loads on sign-in.
- Overview now contains upcoming events, open tasks, unread inbox updates,
  assigned-course counts, and direct workspace shortcuts. The leaderboard is
  still available from its own dashboard menu item.
- Personal events and hidden/status preferences are stored under the member's
  own calendarEvents and calendarOverrides subcollections. Other accounts,
  including admins, cannot read or edit those private calendar documents.
- Existing uploaded site features, including ratings/team leads, are retained.
  Old schedule collection records are archived (admin read/delete only), not
  erased by this file update.
- Admins can be assigned to one team as a team member or team leader from the
  team-management panel. Their account remains an Admin with global permissions;
  this assignment identifies their team and lists them in that team's roster.
- Admins can submit tasks assigned to Admins, plus tasks for the single team
  assigned to their account. XP is awarded through the existing review process.
- Admins now have a Dashboard access panel. Grant an individual capability to
  any active non-admin member, an account role, or a university tag.
- Available capabilities: create/manage forms; read all forms; read form
  submissions; create/manage courses; read the course library and private
  course lessons; manage Technical materials; read Technical materials; and
  view the designer resource library.
- Granted tools appear in the recipient's dashboard navigation. Read-only access
  hides editing controls. The Firestore rules enforce the same grants; changing
  a dashboard button alone does not grant access.
- Grants remain separate from account roles and never grant Admin privileges.
  Access updates are picked up the next time a recipient loads their dashboard.

INBOX NOTIFICATIONS
- Dashboard access additions/removals notify the active members matching the
  selected role, university, or individual. Saving an unchanged set does not
  send another access notice. Grants do not broadcast to unrelated members.
- New Technical materials notify Technical-role members AND current viewers/
  managers granted access individually, by role, or by university.
  This also works when a delegated Technical-material manager adds a resource.
- Course assignments, removals and course edits notify the affected assignees.
- New tasks notify their target team (including Admins assigned to that team).
  New task submissions notify active Admin reviewers. Submission notices have
  stable IDs to prevent duplicate notices for the same submission.
- New questions notify the selected team and Admins assigned to that team.
- Personal leader-chat messages notify the other participant. Attendance
  overrides notify the affected person without disclosing admin notes.
- Publishing or changing a targeted form notifies its audience. New form
  responses notify the active form creator without including submitted answers
  or respondent identity in the notice. Public forms still allow signed-out responses.
  Older forms without a createdBy field still accept submissions but cannot
  identify a creator to notify.
- New session invitations and cancellations notify matching role/university
  audiences and individually invited members. Calendars still sync separately.
- Existing answer, task-review, XP, rating and member-assignment notices remain
  in place. Admin team assignments now notify the affected Admin too.
- Inbox action buttons open the relevant dashboard area, form or session.
- New broadcast-style notices skip the person performing the action and
  deduplicate recipients. Private notes and form answers are not broadcast.
- Notification failures after an action saves are reported separately so a
  successful assignment/submission is not mistaken for a failed action.

SCOPE
These are notifications generated by the website actions listed above, not a
database-wide server trigger. Direct Firebase Console edits, external scripts,
live video-room chat messages and unrelated maintenance actions do not generate new inbox
notices through this update. Existing browser push setup is unchanged; this
update delivers persistent dashboard inbox messages.

IMPORTANT — VIDEO TOKEN WORKER
The uploaded files do not include the Cloudflare Worker that issues NawrasOnline
video-room tokens. The calendar, session listing, invitation picker and Firestore
access rules support individual invitations, but the Worker's authorization
cannot be verified or changed from the supplied files.
If its checks only recognise role/university audiences, it must additionally
permit a UID present in session.targetMemberUids. Do not weaken token validation
or make rooms public. Upload the Worker source to have this checked precisely.

VERIFICATION
- JavaScript syntax and HTML IDs checked.
- Admin team member/leader choices, team roster grouping, and admin-only
  assignment validation checked.
- Admin task submission scope, XP workflow checks, and existing member-role
  submission access checked.
- Role, university, and individual dashboard grants, dashboard sections, and
  matching Firestore checks validated statically.
- Mocked execution tested recipient deduplication, sender exclusion, grant
  scopes, Technical resource recipients, session invitations/cancellations,
  course assignment/removal/update, signed-out form response notices, team
  question notices, personal leader chats and attendance notices.
  This is not a live Firebase authorization test.
- The Dashboard access panel was checked in real Chromium at 375px, 768px and
  1280px using its actual markup/CSS. Controls remained visible without
  horizontal overflow. This layout check did not sign in to Firebase.
- Audience, dates, status and month-grid logic tested.
- Real Chromium browser tests using MOCK Firestore covered personal event CRUD,
  status persistence, hide/restore, live session updates/cancellations, auth
  listener cleanup, and layouts at 375px, 768px and 1280px.
- These tests did not access or modify your live Firebase data.
- Live Firebase rule compilation/deployment and the video token service were not
  tested here. Deploy rules/indexes, then test with an admin and one recipient
  account for each scope you use.
