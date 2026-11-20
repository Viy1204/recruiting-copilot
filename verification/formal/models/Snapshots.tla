----------------------------- MODULE Snapshots -----------------------------
EXTENDS Naturals, Integers

\* reader.mjs:54-58 分别读取来源，再调用 buildSnapshot。
\* 下列三次读取是独立观察，不是多文件事务。
\* model.mjs:88 投影台账文本；候选阶段不表示自动推进。
VARIABLES prior, phase, ledgerSource, contextSource, configSource, view, marks,
          result
vars == <<prior, phase, ledgerSource, contextSource, configSource, view, marks,
          result>>

LastTrusted == [candidates |-> "oldPeople", roles |-> 1,
                unknownStatuses |-> 1, ledgerUpdatedAt |-> 1,
                contextRevision |-> 1, ledgerStamp |-> 1,
                contextStamp |-> 1, configStamp |-> 1, count |-> 1]
EmptyView == [candidates |-> "unknown", roles |-> 0,
              unknownStatuses |-> 0, ledgerUpdatedAt |-> 0,
              contextRevision |-> 0, ledgerStamp |-> 0,
              contextStamp |-> 0, configStamp |-> 0, count |-> -1]
StaleMarks == [ledger |-> "stale", context |-> "stale", config |-> "stale"]
HasTrusted == prior # "cold"
ReadableLedger == ledgerSource \in {"people", "empty"}
UsableConfig == configSource = "ok" /\ contextSource = "ok"
KeepTrusted == HasTrusted /\ (~UsableConfig \/ ~ReadableLedger)

Init ==
  /\ prior \in {"cold", "trusted", "stale"}
  /\ phase = "ledger"
  /\ ledgerSource = "pending"
  /\ contextSource = "pending"
  /\ configSource = "pending"
  /\ view = EmptyView
  /\ marks = [ledger |-> "pending", context |-> "pending", config |-> "pending"]
  /\ result = "pending"

\* readSource(ledger) 可返回缺失、错误或可解析 CSV，包括有效空表。
ReadLedger ==
  /\ phase = "ledger"
  /\ ledgerSource' \in {"people", "empty", "invalid", "missing"}
  /\ phase' = "context"
  /\ UNCHANGED <<prior, contextSource, configSource, view, marks, result>>

\* 已用配置存在时，岗位表失效也会使别名目标校验失效。
ReadContext ==
  /\ phase = "context"
  /\ contextSource' \in IF HasTrusted THEN {"ok", "invalid", "missing"}
                       ELSE {"ok"}
  /\ phase' = "config"
  /\ UNCHANGED <<prior, ledgerSource, configSource, view, marks, result>>

ReadConfig ==
  /\ phase = "config"
  /\ configSource' \in IF HasTrusted THEN {"ok", "invalid", "missing"}
                      ELSE {"missing"}
  /\ phase' = "project"
  /\ UNCHANGED <<prior, ledgerSource, contextSource, view, marks, result>>

\* 同步纯函数 buildSnapshot 为一步，不是文件系统提交。
\* model.mjs:557-570、583-591 整套保留可信投影。
ProjectSnapshot ==
  /\ phase = "project"
  /\ view' = IF KeepTrusted THEN LastTrusted
             ELSE IF ReadableLedger
             THEN [candidates |-> IF ledgerSource = "empty" THEN "empty" ELSE "newPeople",
                   roles |-> 2, unknownStatuses |-> 2, ledgerUpdatedAt |-> 2,
                   contextRevision |-> 2, ledgerStamp |-> 2, contextStamp |-> 2,
                   configStamp |-> IF configSource = "ok" THEN 2 ELSE 0,
                   count |-> IF ledgerSource = "empty" THEN 0 ELSE 2]
             ELSE [EmptyView EXCEPT !.roles = 2, !.contextRevision = 2,
                                    !.contextStamp = 2]
  /\ marks' = IF KeepTrusted THEN StaleMarks
              ELSE [ledger |-> IF ReadableLedger THEN "ok"
                               ELSE IF ledgerSource = "missing" THEN "missing" ELSE "error",
                    context |-> "ok", config |-> configSource]
  /\ result' = IF KeepTrusted THEN "stale"
               ELSE IF ReadableLedger THEN "fresh" ELSE "unknown"
  /\ phase' = "done"
  /\ UNCHANGED <<prior, ledgerSource, contextSource, configSource>>

Done == phase = "done" /\ UNCHANGED vars

Next == ReadLedger \/ ReadContext \/ ReadConfig \/ ProjectSnapshot \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ prior \in {"cold", "trusted", "stale"}
  /\ phase \in {"ledger", "context", "config", "project", "done"}
  /\ ledgerSource \in {"pending", "people", "empty", "invalid", "missing"}
  /\ contextSource \in {"pending", "ok", "invalid", "missing"}
  /\ configSource \in {"pending", "ok", "invalid", "missing"}
  /\ view \in [candidates : {"unknown", "empty", "oldPeople", "newPeople"},
                roles : 0..2, unknownStatuses : 0..2, ledgerUpdatedAt : 0..2,
                contextRevision : 0..2, ledgerStamp : 0..2, contextStamp : 0..2,
                configStamp : 0..2, count : {-1, 0, 1, 2}]
  /\ marks \in [{"ledger", "context", "config"} ->
                 {"pending", "ok", "missing", "error", "stale"}]
  /\ result \in {"pending", "fresh", "stale", "unknown"}

\* 未知不能冒充零；配置来源失败时不能混合新旧口径。
SnapshotTruth ==
  /\ ((phase = "done" /\ KeepTrusted) =>
       (view = LastTrusted /\ marks = StaleMarks /\ result = "stale"))
  /\ ((phase = "done" /\ ~HasTrusted /\ ~ReadableLedger) =>
       (view.candidates = "unknown" /\ view.count = -1 /\ result = "unknown"))
  /\ ((phase = "done" /\ ~KeepTrusted /\ ledgerSource = "empty") =>
       (view.candidates = "empty" /\ view.count = 0))
=============================================================================
