-------------------------- MODULE InterviewFlow --------------------------
\* 这是工作流义务，不证明执行者或外部日历必然遵守。
\* 依据 skills/interview-schedule/SKILL.md:44-82 及 ADR 0005。
VARIABLES phase, approved, calendar, invitation, schedule, ledger, event
vars == <<phase, approved, calendar, invitation, schedule, ledger, event>>

Init ==
  /\ phase = "prepare" /\ approved = FALSE /\ calendar = FALSE
  /\ invitation = FALSE /\ schedule = FALSE /\ ledger = FALSE /\ event = FALSE
Prepare ==
  /\ phase = "prepare" /\ phase' = "awaiting_user"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
Approve ==
  /\ phase = "awaiting_user" /\ phase' = "creating" /\ approved' = TRUE
  /\ UNCHANGED <<calendar, invitation, schedule, ledger, event>>
CalendarVerified ==
  /\ phase \in {"creating", "verify_calendar"} /\ approved
  /\ phase' = "deliver_invitation" /\ calendar' = TRUE
  /\ UNCHANGED <<approved, invitation, schedule, ledger, event>>
CalendarUncertain ==
  /\ phase = "creating" /\ phase' = "verify_calendar"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
CalendarAbsent ==
  /\ phase = "verify_calendar" /\ phase' = "creating"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
DeliverInvitation ==
  /\ phase = "deliver_invitation" /\ phase' = "sync" /\ invitation' = TRUE
  /\ UNCHANGED <<approved, calendar, schedule, ledger, event>>
WriteSchedule ==
  /\ phase = "sync" /\ ~schedule /\ schedule' = TRUE
  /\ UNCHANGED <<phase, approved, calendar, invitation, ledger, event>>
WriteLedger ==
  /\ phase = "sync" /\ ~ledger /\ ledger' = TRUE
  /\ UNCHANGED <<phase, approved, calendar, invitation, schedule, event>>
WriteEvent ==
  /\ phase = "sync" /\ ~event /\ event' = TRUE
  /\ UNCHANGED <<phase, approved, calendar, invitation, schedule, ledger>>
SyncFailed ==
  /\ phase = "sync" /\ ~(schedule /\ ledger /\ event) /\ phase' = "partial"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
RetryMissingSync ==
  /\ phase = "partial" /\ phase' = "sync"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
SyncComplete ==
  /\ phase = "sync" /\ schedule /\ ledger /\ event /\ phase' = "read_overview"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
OverviewVerified ==
  /\ phase = "read_overview" /\ phase' = "done"
  /\ UNCHANGED <<approved, calendar, invitation, schedule, ledger, event>>
Done == phase = "done" /\ UNCHANGED vars

Next == Prepare \/ Approve \/ CalendarVerified \/ CalendarUncertain \/ CalendarAbsent
        \/ DeliverInvitation \/ WriteSchedule \/ WriteLedger \/ WriteEvent
        \/ SyncFailed \/ RetryMissingSync \/ SyncComplete \/ OverviewVerified \/ Done
CalendarRequiresApproval == calendar => approved
DoneRequiresAllEvidence == phase = "done" =>
  (approved /\ calendar /\ invitation /\ schedule /\ ledger /\ event)
=============================================================================
