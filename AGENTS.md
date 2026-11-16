# Dashboard controls

Use the dashboard's styled buttons and switches. Avoid browser-default button styles and visible native checkboxes. Keep switches keyboard accessible.

Display editable text as entered, preserving uppercase and lowercase letters.
Keep scrollbars hidden in editable text fields, including multiline fields. Keep overflow text reachable through normal editing and scrolling.

Save edits to existing dashboard settings automatically. Use Done for editors that need a closing action, and finish any pending save before closing.

# Bot message formatting

Use bold, normal-sized headings for embedded bot messages and Components V2 containers. Place a native separator immediately after the heading in Components V2 containers, before the body. In Tools, the divider is optional for Components V2 and unavailable for regular embeds. Do not use Markdown heading prefixes.

All moderation DMs are description-only embeds with color #f45f77: no heading, separator, icon, case number, or internal error details. Warning DMs read "You were warned in [server] for [reason]", with an optional message link below. Clear-case DMs read "Warning '[original warning reason]' has been cleared from you".

Use neutral gray (ButtonStyle.Secondary) for Discord message buttons; do not use colored button styles.

Save edited files as UTF-8. Prefer ASCII apostrophes and hyphens in interface strings to avoid encoding substitutions.

Keep moderation logs concise: case/action, user and moderator names, reason, and relevant duration or message link. Omit routine success details such as DM delivery and log delivery. Report failures only to moderators and admin logs.

Keep all embedded bot messages clean and simple. Use short, direct wording and only information needed for the action. Omit redundant status lines, technical details, and routine delivery confirmations. Preserve the heading, DM, color, and button rules above.

Moderation log-channel messages also use description-only embeds with color #f45f77, without headings, icons, separators, or bold labels. Keep action, username, moderator, reason, and relevant details concise.
