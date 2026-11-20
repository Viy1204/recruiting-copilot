------------------------------- MODULE Live -------------------------------
EXTENDS Naturals
\* createSnapshotController 对应 public/live.mjs:23-83。
\* current/obsolete 抽象 request.generation === generation 的比较结果；
\* 同一请求尚未结束时，重复失效对这项比较具有相同效果。
VARIABLES active, flight, queued, timedOut, loads, delivery
vars == <<active, flight, queued, timedOut, loads, delivery>>

Init == /\ active = FALSE /\ flight = "none" /\ queued = FALSE
        /\ timedOut = FALSE /\ loads = 0 /\ delivery = <<TRUE, TRUE, TRUE>>

Resume == /\ ~active /\ active' = TRUE
          /\ flight' = IF flight = "none" THEN "current" ELSE flight
          /\ queued' = (flight # "none")
          /\ timedOut' = IF flight = "none" THEN FALSE ELSE timedOut
          /\ loads' = IF flight = "none" THEN loads + 1 ELSE loads
          /\ UNCHANGED delivery
Refresh == /\ active /\ flight = "none"
           /\ flight' = "current" /\ loads' = loads + 1
           /\ queued' = FALSE /\ timedOut' = FALSE
           /\ UNCHANGED <<active, delivery>>
Invalidate == /\ active /\ flight # "none"
              /\ flight' = "obsolete" /\ queued' = TRUE
              /\ UNCHANGED <<active, timedOut, loads, delivery>>
Suspend == /\ active /\ active' = FALSE /\ queued' = FALSE
           /\ flight' = IF flight = "none" THEN "none" ELSE "obsolete"
           /\ UNCHANGED <<timedOut, loads, delivery>>
Timeout == /\ active /\ flight = "current" /\ ~timedOut
           /\ timedOut' = TRUE
           /\ UNCHANGED <<active, flight, queued, loads, delivery>>

Finish == /\ flight # "none"
          /\ flight' = IF active /\ queued THEN "current" ELSE "none"
          /\ loads' = loads - 1 + (IF active /\ queued THEN 1 ELSE 0)
          /\ queued' = FALSE
          /\ timedOut' = IF active /\ queued THEN FALSE ELSE timedOut
          /\ UNCHANGED active
ReceiveSuccess == /\ Finish
                  /\ delivery' = IF active /\ flight = "current" /\ ~timedOut
                                  THEN <<active, flight = "current", ~timedOut>>
                                  ELSE delivery
ReceiveError == /\ Finish /\ UNCHANGED delivery

Next == Resume \/ Refresh \/ Invalidate \/ Suspend \/ Timeout
        \/ ReceiveSuccess \/ ReceiveError
TypeOK == /\ active \in BOOLEAN /\ flight \in {"none", "current", "obsolete"}
          /\ queued \in BOOLEAN /\ timedOut \in BOOLEAN
          /\ loads \in 0..2 /\ delivery \in BOOLEAN \X BOOLEAN \X BOOLEAN
SingleFlight == loads <= 1
NoObsoletePublication == delivery[1] /\ delivery[2] /\ delivery[3]
=============================================================================
