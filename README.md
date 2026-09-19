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

## Feature 2: Incident reports and invoices

- `/incident-report` uses a two-step, simplified **SOAP** form with separate responder name, responder call sign, patient name, Subjective, Objective, Assessment, and Plan fields.
- `/quick-invoice` opens an **EMS QUICK INVOICE** form with separate responder name and call sign fields, patient name, Bandages, Saline, Morphine, med-kit usage, and explanatory details.
- `/incident-config channel` (Manage Server) selects where completed reports and invoices are posted. Until configured, they post in the channel where the form was submitted.
- Reports and invoices are retained in the local CAD data file with a unique reference ID and submitting user.
- The bot assigns every new report and invoice the next persistent incident number, beginning at **4001**.
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

Data is stored locally in `data/clock-data.json`; use a persistent volume when deploying the bot.
