------------------------------ MODULE Mirror ------------------------------
\* lib/index.js:409-423 为熔断与解除；:746 为贴合入口；:910 为自愈入口。
\* 无贴合需求分支 :755、761 的两条 CDP 写入以 await 分开。
\* 等待期间可收到风险事件；首条返回后重新检查，熔断就结束该次还原。
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
  /\ fitPhase' = IF risk = "none" THEN "waiting_clear" ELSE "idle"
  /\ writeRisk' = IF risk = "none" THEN FALSE ELSE writeRisk
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
