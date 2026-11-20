-------------------------- MODULE RecruitingFlow --------------------------
EXTENDS Naturals
VARIABLES phase, authorized, effect, progress
vars == <<phase, authorized, effect, progress>>

Init == /\ phase = "read"
        /\ authorized = FALSE
        /\ effect = FALSE
        /\ progress = FALSE

ReadConfirmedStandards == /\ phase = "read"
                         /\ phase' = "screen"
                         /\ UNCHANGED <<authorized, effect, progress>>
ScreenAndRecord == /\ phase = "screen"
                   /\ phase' = "awaiting_user"
                   /\ UNCHANGED <<authorized, effect, progress>>
UserApproves == /\ phase = "awaiting_user"
                /\ phase' = "ready"
                /\ authorized' = TRUE
                /\ UNCHANGED <<effect, progress>>
UserDefers == /\ phase = "awaiting_user"
              /\ phase' = "deferred"
              /\ UNCHANGED <<authorized, effect, progress>>
ResumeDecision == /\ phase = "deferred"
                  /\ phase' = "awaiting_user"
                  /\ UNCHANGED <<authorized, effect, progress>>
ExternalSuccess == /\ phase = "ready" /\ authorized /\ ~effect
                   /\ phase' = "sync_pending"
                   /\ effect' = TRUE
                   /\ UNCHANGED <<authorized, progress>>
ExternalUncertain == /\ phase = "ready" /\ authorized /\ ~effect
                     /\ phase' = "verify_result"
                     /\ UNCHANGED <<authorized, effect, progress>>
VerifyAlreadySucceeded == /\ phase = "verify_result"
                          /\ phase' = "sync_pending"
                          /\ effect' = TRUE
                          /\ UNCHANGED <<authorized, progress>>
VerifyNotExecuted == /\ phase = "verify_result"
                     /\ phase' = "ready"
                     /\ UNCHANGED <<authorized, effect, progress>>
RecordProfileEvent == /\ phase = "sync_pending"
                      /\ phase' = "read_overview"
                      /\ progress' = TRUE
                      /\ UNCHANGED <<authorized, effect>>
ReadBackOverview == /\ phase = "read_overview"
                    /\ phase' = "done"
                    /\ UNCHANGED <<authorized, effect, progress>>
Done == /\ phase = "done" /\ UNCHANGED vars

Next == ReadConfirmedStandards \/ ScreenAndRecord \/ UserApproves \/ UserDefers
        \/ ResumeDecision \/ ExternalSuccess \/ ExternalUncertain
        \/ VerifyAlreadySucceeded \/ VerifyNotExecuted \/ RecordProfileEvent
        \/ ReadBackOverview \/ Done

ConfirmationBeforeAction == effect => authorized
CompletedHasVisibleProgress == phase = "done" => (effect /\ progress)
=============================================================================
