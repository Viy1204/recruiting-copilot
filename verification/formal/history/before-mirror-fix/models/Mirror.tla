------------------------------ MODULE Mirror ------------------------------
\* lib/index.js:409-423 risk latch/clear; :746 fit entry; :907 watchdog gate.
\* The no-fit-request branch at :755-756 has TWO separate CDP writes with
\* an await between them. A risk event can arrive while the first is pending.
VARIABLES risk, firstRisk, eligible, lastAttempt, attemptRisk, fitPhase, writeRisk
vars == <<risk, firstRisk, eligible, lastAttempt, attemptRisk, fitPhase, writeRisk>>
URLs == {"verification", "restriction"}
Init ==
  /\ risk = "none" /\ firstRisk = "none" /\ eligible = FALSE
  /\ lastAttempt = "none" /\ attemptRisk = FALSE
  /\ fitPhase = "idle" /\ writeRisk = FALSE

ObserveRisk(url) ==
  /\ url \in URLs
  /\ risk' = IF risk = "none" THEN url ELSE risk
  /\ firstRisk' = IF risk = "none" THEN url ELSE firstRisk
  /\ UNCHANGED <<eligible, lastAttempt, attemptRisk, fitPhase, writeRisk>>
ManualClear ==
  /\ risk # "none" /\ risk' = "none" /\ firstRisk' = "none"
  /\ UNCHANGED <<eligible, lastAttempt, attemptRisk, fitPhase, writeRisk>>
EligibilityChanges ==
  /\ eligible' = ~eligible
  /\ UNCHANGED <<risk, firstRisk, lastAttempt, attemptRisk, fitPhase, writeRisk>>
TryRecovery ==
  /\ lastAttempt' = IF eligible /\ risk = "none" THEN "admitted" ELSE "stopped"
  /\ attemptRisk' = (risk # "none")
  /\ UNCHANGED <<risk, firstRisk, eligible, fitPhase, writeRisk>>
TryFit ==
  /\ fitPhase = "idle"
  /\ lastAttempt' = IF risk = "none" THEN "admitted" ELSE "stopped"
  /\ attemptRisk' = (risk # "none")
  /\ fitPhase' = IF risk = "none" THEN "waiting_first" ELSE "idle"
  /\ writeRisk' = IF risk = "none" THEN FALSE ELSE writeRisk
  /\ UNCHANGED <<risk, firstRisk, eligible>>
FirstCommandReturns ==
  /\ fitPhase = "waiting_first"
  /\ fitPhase' = "waiting_clear"
  /\ writeRisk' = (risk # "none")
  /\ UNCHANGED <<risk, firstRisk, eligible, lastAttempt, attemptRisk>>
ClearCommandReturns ==
  /\ fitPhase = "waiting_clear" /\ fitPhase' = "idle"
  /\ UNCHANGED <<risk, firstRisk, eligible, lastAttempt, attemptRisk, writeRisk>>

Next == (\E url \in URLs : ObserveRisk(url)) \/ ManualClear
        \/ EligibilityChanges \/ TryRecovery \/ TryFit
        \/ FirstCommandReturns \/ ClearCommandReturns
TypeOK ==
  /\ risk \in URLs \cup {"none"} /\ firstRisk \in URLs \cup {"none"}
  /\ eligible \in BOOLEAN /\ lastAttempt \in {"none", "admitted", "stopped"}
  /\ attemptRisk \in BOOLEAN
  /\ fitPhase \in {"idle", "waiting_first", "waiting_clear"}
  /\ writeRisk \in BOOLEAN
FirstRiskIsRetained == risk # "none" => risk = firstRisk
NoMaintenanceAdmittedInRisk == lastAttempt = "admitted" => ~attemptRisk
NoViewportDispatchAfterRisk == ~writeRisk
=============================================================================
