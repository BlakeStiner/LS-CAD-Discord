const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const rosterChoices = [
  { name: 'Lakeside EMS', value: 'Lakeside EMS' },
  { name: 'Lakeside Police Department', value: 'Lakeside Police Department' },
  { name: 'Lakeside Sheriff Office', value: 'Lakeside Sheriff Office' },
  { name: 'Nevada State Patrol', value: 'Nevada State Patrol' },
];

const commands = [
  new SlashCommandBuilder()
    .setName('clock-panel')
    .setDescription('Create or refresh the clock-in control panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName('channel').setDescription('Dedicated clock-in channel (defaults to this channel)')),
  new SlashCommandBuilder()
    .setName('duty-roster')
    .setDescription('Create or refresh the live on-duty roster')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName('channel').setDescription('Channel for the live roster (defaults to this channel)')),
  new SlashCommandBuilder()
    .setName('clock-config')
    .setDescription('Configure inactivity strike enforcement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption(option => option.setName('tracked-role').setDescription('Members to include in inactivity checks'))
    .addIntegerOption(option => option.setName('inactivity-days').setDescription('Days before first strike (default: 7)').setMinValue(1).setMaxValue(365)),
  new SlashCommandBuilder()
    .setName('clock-status')
    .setDescription('View a member’s shift and attendance status')
    .addUserOption(option => option.setName('member').setDescription('Member to inspect')),
  new SlashCommandBuilder()
    .setName('clock-report')
    .setDescription('View completed shift history')
    .addUserOption(option => option.setName('member').setDescription('Member to inspect'))
    .addIntegerOption(option => option.setName('days').setDescription('History window in days (default: 30)').setMinValue(1).setMaxValue(365)),
  new SlashCommandBuilder()
    .setName('clock-strike')
    .setDescription('Adjust a member’s attendance strikes')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName('member').setDescription('Member to adjust').setRequired(true))
    .addStringOption(option => option.setName('action').setDescription('Change to make').setRequired(true)
      .addChoices(
        { name: 'Add one strike', value: 'add' },
        { name: 'Remove one strike', value: 'remove' },
        { name: 'Clear all strikes', value: 'clear' },
      ))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the adjustment').setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('time-add')
    .setDescription('Add a manual completed shift for a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName('member').setDescription('Member receiving the shift').setRequired(true))
    .addStringOption(option => option.setName('roster').setDescription('Roster for the shift').setRequired(true).addChoices(...rosterChoices))
    .addStringOption(option => option.setName('start').setDescription('ISO 8601 start, e.g. 2026-09-18T08:00:00-06:00').setRequired(true).setMaxLength(40))
    .addStringOption(option => option.setName('end').setDescription('ISO 8601 end, e.g. 2026-09-18T16:00:00-06:00').setRequired(true).setMaxLength(40))
    .addStringOption(option => option.setName('reason').setDescription('Why this manual entry is needed').setRequired(true).setMaxLength(300)),
  new SlashCommandBuilder()
    .setName('time-edit')
    .setDescription('Correct a completed shift; it will require approval')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName('member').setDescription('Member owning the shift').setRequired(true))
    .addStringOption(option => option.setName('shift-id').setDescription('Short shift ID from /clock-report').setRequired(true).setMinLength(4).setMaxLength(36))
    .addStringOption(option => option.setName('reason').setDescription('Reason for this correction').setRequired(true).setMaxLength(300))
    .addStringOption(option => option.setName('roster').setDescription('Corrected roster').addChoices(...rosterChoices))
    .addStringOption(option => option.setName('start').setDescription('Corrected ISO 8601 start').setMaxLength(40))
    .addStringOption(option => option.setName('end').setDescription('Corrected ISO 8601 end').setMaxLength(40)),
  new SlashCommandBuilder()
    .setName('time-approve')
    .setDescription('Approve or reject a pending manual/corrected shift')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName('member').setDescription('Member owning the shift').setRequired(true))
    .addStringOption(option => option.setName('shift-id').setDescription('Short shift ID from /clock-report').setRequired(true).setMinLength(4).setMaxLength(36))
    .addStringOption(option => option.setName('decision').setDescription('Approval decision').setRequired(true)
      .addChoices({ name: 'Approve', value: 'approved' }, { name: 'Reject', value: 'rejected' }))
    .addStringOption(option => option.setName('note').setDescription('Optional review note').setMaxLength(300)),
  new SlashCommandBuilder()
    .setName('loa-request')
    .setDescription('Request a leave of absence')
    .addStringOption(option => option.setName('start-date').setDescription('First day of leave (YYYY-MM-DD)').setRequired(true).setMinLength(10).setMaxLength(10))
    .addStringOption(option => option.setName('end-date').setDescription('Last day of leave (YYYY-MM-DD)').setRequired(true).setMinLength(10).setMaxLength(10))
    .addStringOption(option => option.setName('reason').setDescription('Reason for the leave request').setRequired(true).setMaxLength(300)),
  new SlashCommandBuilder()
    .setName('loa-review')
    .setDescription('Approve or decline a leave-of-absence request')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName('member').setDescription('Member who requested leave').setRequired(true))
    .addStringOption(option => option.setName('request-id').setDescription('Short request ID from /loa-status').setRequired(true).setMinLength(4).setMaxLength(36))
    .addStringOption(option => option.setName('decision').setDescription('Approval decision').setRequired(true)
      .addChoices({ name: 'Approve', value: 'approved' }, { name: 'Decline', value: 'declined' }))
    .addStringOption(option => option.setName('note').setDescription('Optional decision note').setMaxLength(300)),
  new SlashCommandBuilder()
    .setName('loa-status')
    .setDescription('View leave-of-absence requests')
    .addUserOption(option => option.setName('member').setDescription('Member to inspect')),
].map(command => command.toJSON());

module.exports = commands;
