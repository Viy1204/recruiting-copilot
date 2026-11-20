------------------------------ MODULE Runs ------------------------------
EXTENDS Naturals, Sequences

\* 来源：skills/recruit-board/model.mjs createRun:316、validateRun:331、
\* transitionRun:394；scripts/progress.mjs recordProgress:21。
\* 一个纯 transitionRun 调用是一步；不把 run 文件、事项目录合为事务。
\* 固定两项代表步骤，其余步骤在契约测试中用公开入口跳过。
\* 不假定步骤顺序，也不要求 summary 先于 complete。
Steps == 1..2
RunStates == {"running", "waiting", "completed", "failed", "cancelled"}
StepStates == {"pending", "running", "completed", "skipped", "failed"}
TerminalStates == {"completed", "failed", "cancelled"}
VARIABLES status, steps, sealed
vars == <<status, steps, sealed>>

Init == /\ status = "running"
        /\ steps = [i \in Steps |-> "pending"]
        /\ sealed = [ended |-> FALSE, status |-> "running", steps |-> steps]

Live == status \in {"running", "waiting"}
Settled(value) == \A i \in Steps : value[i] \in {"completed", "skipped"}

\* sealed 是观察量：首次结束时记住投影，不是产品中的额外锁。
Seal(nextStatus, nextSteps) ==
  /\ status' = nextStatus
  /\ steps' = nextSteps
  /\ sealed' = IF ~sealed.ended
               THEN [ended |-> TRUE, status |-> nextStatus, steps |-> nextSteps]
               ELSE sealed

StartStep ==
  /\ Live
  /\ \E i \in Steps :
       /\ steps[i] \in {"pending", "running"}
       /\ \A j \in Steps \ {i} : steps[j] # "running"
       /\ steps' = [steps EXCEPT ![i] = "running"]
       /\ status' = "running"
       /\ UNCHANGED sealed

CompleteStep ==
  /\ Live
  /\ \E i \in Steps :
       /\ steps[i] = "running"
       /\ steps' = [steps EXCEPT ![i] = "completed"]
       /\ status' = "running"
       /\ UNCHANGED sealed

SkipStep ==
  /\ Live
  /\ \E i \in Steps :
       /\ steps[i] \in {"pending", "running"}
       /\ steps' = [steps EXCEPT ![i] = "skipped"]
       /\ status' = "running"
       /\ UNCHANGED sealed

Wait == /\ Live
        /\ status' = "waiting"
        /\ UNCHANGED <<steps, sealed>>

CompleteRun == /\ Live
               /\ Settled(steps)
               /\ Seal("completed", steps)

FailStep ==
  /\ Live
  /\ \E i \in Steps :
       /\ steps[i] \in {"pending", "running"}
       /\ Seal("failed", [steps EXCEPT ![i] = "failed"])

FailRun ==
  /\ Live
  /\ LET active == {i \in Steps : steps[i] = "running"}
     IN IF active = {} THEN Seal("failed", steps)
        ELSE \E i \in active : Seal("failed", [steps EXCEPT ![i] = "failed"])

CancelRun == /\ Live /\ Seal("cancelled", steps)
Done == /\ status \in TerminalStates /\ UNCHANGED vars

Next == StartStep \/ CompleteStep \/ SkipStep \/ Wait \/ CompleteRun
        \/ FailStep \/ FailRun \/ CancelRun \/ Done

TypeOK == /\ status \in RunStates
          /\ steps \in [Steps -> StepStates]
          /\ sealed \in [ended : BOOLEAN, status : RunStates, steps : [Steps -> StepStates]]

\* 同一个用户承诺：结束结果可信，既不能假完成，也不能事后改写。
RunFinalizationIsTrustworthy ==
  /\ (status = "completed" => Settled(steps))
  /\ (sealed.ended => <<status, steps>> = <<sealed.status, sealed.steps>>)
=============================================================================
