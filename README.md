# Lakeside Medical CAD

Discord bot foundation for replacing FiveRoster's clock-in functionality.

## Feature 1: Clocking and attendance strikes

- A persistent **Clock In / Clock Out** control panel in a dedicated Discord channel.
- Clock-ins use a roster drop-down (Lakeside EMS, Lakeside Police Department, Lakeside Sheriff Office, or Nevada State Patrol) and record the selected roster with the timestamp.
- Clock-outs calculate and save the shift duration.
- Shift safety reminders: direct messages at 8 and 12 hours, then automatic clock-out at 24 hours with a direct-message confirmation and public audit entry.
- A persistent live duty roster showing on-duty members, their department and start time, plus off-duty members. It refreshes at every shift transition and every five minutes.
- Private confirmations and public shift activity embeds.
- Per-member shift history, total time, and strike count.
- Manager-only manual shift entries and corrections, with short shift IDs, approval/rejection, and immutable audit details stored on each shift.
- An hourly inactivity check gives one strike at 7 days without clocking in, then one additional strike for each full week after that. A configured tracking role defines who is eligible; without one, only members who have previously clocked in are evaluated. Role-based enforcement starts when that role is configured, so it never backdates penalties.

Discord cannot move a message in place. The bot reposts its one control panel after activity in the configured clock channel, keeping it at the bottom; use a dedicated clock channel so the feed stays tidy. The panel buttons remain usable after restarts.

## Feature 2: Leave of absence

- Members submit inclusive date-range requests with `/loa-request`.
- Managers approve or decline with `/loa-review`; the member receives the outcome by direct message when possible.
- `/loa-status` lists a member's request IDs and states. Reasons are visible only to the member and server managers.
- Approved leave time is excluded from inactivity-strike calculations, so strike timing pauses for the approved dates. Pending or declined requests have no effect.

## Setup

1. Create an application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. In **Bot**, enable *Server Members Intent*. Invite the bot with `bot` and `applications.commands` scopes. It needs View Channel, Send Messages, Embed Links, Read Message History, and Manage Messages (only to refresh its panel).
3. Copy `.env.example` to `.env` and supply the token and application ID.
4. Install and run:

   ```powershell
   npm install
   npm start
   ```

5. In Discord, run `/clock-panel` in or target the dedicated clock channel. Optionally run `/clock-config tracked-role:@EMS` to include every EMS member in inactivity checks, including members who have never clocked in.

## Commands

| Command | Who can use it | Purpose |
| --- | --- | --- |
| `/clock-panel [channel]` | Manage Server | Create or refresh the clock control panel |
| `/duty-roster [channel]` | Manage Server | Create or refresh the live on-duty/off-duty roster |
| `/clock-config [tracked-role] [inactivity-days]` | Manage Server | Configure attendance enforcement (defaults to 7 days) |
| `/clock-status [member]` | Everyone | See active shift, time totals, and attendance state |
| `/clock-report [member] [days]` | Everyone | See completed shifts for the chosen period |
| `/clock-strike member action [reason]` | Manage Server | Add, remove, or clear strikes with an audit reason |
| `/time-add member roster start end reason` | Manage Server | Add a manual shift for approval; timestamps use ISO 8601 format |
| `/time-edit member shift-id [roster] [start] [end] reason` | Manage Server | Correct a completed shift and return it to pending approval |
| `/time-approve member shift-id decision [note]` | Manage Server | Approve or reject a pending manual/corrected shift |
| `/loa-request start-date end-date reason` | Everyone | Request a date-bound leave of absence using YYYY-MM-DD dates |
| `/loa-status [member]` | Everyone | View leave-request statuses and short request IDs |
| `/loa-review member request-id decision [note]` | Manage Server | Approve or decline a pending leave request |

Data is stored locally in `data/clock-data.json`; use a persistent volume when deploying the bot.
