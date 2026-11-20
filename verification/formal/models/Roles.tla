------------------------------- MODULE Roles -------------------------------
EXTENDS Naturals, FiniteSets

\* roles.mjs:151 的 setRoleAlias 与 :213 的 setRoleStatus 共用 context.lock。
\* 每次选择一个文件；CONTEXT 与别名配置的版本彼此独立。
\* 不臆造岗位业务转移图，状态只是允许写入的普通值。
Writers == {1, 2}
Kinds == {"alias", "status"}
\* 状态符号对应源码五个可写值，不表示顺序。
InitialValues == [alias |-> "officialA", status |-> "active"]
Proposal(kind, writer) == IF kind = "alias"
                         THEN IF writer = 1 THEN "officialB" ELSE "unmapped"
                         ELSE IF writer = 1 THEN "paused" ELSE "closed"
VARIABLES kind, pc, owner, revisions, values, committed, outcome
vars == <<kind, pc, owner, revisions, values, committed, outcome>>

Init ==
  /\ kind \in Kinds
  /\ pc = [writer \in Writers |-> "waiting"]
  /\ owner = 0
  /\ revisions = [file \in Kinds |-> 0]
  /\ values = InitialValues
  /\ committed = {}
  /\ outcome = [writer \in Writers |-> "pending"]

\* 共用互斥点为 :158、:219 的排他锁文件创建。
Acquire(writer) ==
  /\ pc[writer] = "waiting" /\ owner = 0
  /\ owner' = writer
  /\ pc' = [pc EXCEPT ![writer] = "check"]
  /\ UNCHANGED <<kind, revisions, values, committed, outcome>>

\* 两个请求版本均为 0；别名 :168、岗位表 :227 拒绝旧读取。
FirstVersionCheck(writer) ==
  /\ owner = writer /\ pc[writer] = "check"
  /\ pc' = [pc EXCEPT ![writer] = IF revisions[kind] = 0 THEN "recheck" ELSE "release"]
  /\ outcome' = IF revisions[kind] = 0 THEN outcome
                ELSE [outcome EXCEPT ![writer] = "conflict"]
  /\ UNCHANGED <<kind, owner, revisions, values, committed>>

\* 备份和临时输出准备是内部步骤，不是提交。
\* 别名 :199-202 也核对 CONTEXT；本界限内另一文件保持稳定。
\* 最后检查 :202、:240 与异步 rename 分开。
FinalVersionCheck(writer) ==
  /\ owner = writer /\ pc[writer] = "recheck"
  /\ pc' = [pc EXCEPT ![writer] = IF revisions[kind] = 0 THEN "rename" ELSE "release"]
  /\ outcome' = IF revisions[kind] = 0 THEN outcome
                ELSE [outcome EXCEPT ![writer] = "conflict"]
  /\ UNCHANGED <<kind, owner, revisions, values, committed>>

\* 单次 rename 为提交点：别名 :203、岗位表 :241。
RenameConfiguration(writer) ==
  /\ owner = writer /\ pc[writer] = "rename"
  /\ revisions' = [revisions EXCEPT ![kind] = @ + 1]
  /\ values' = [values EXCEPT ![kind] = Proposal(kind, writer)]
  /\ committed' = committed \cup {writer}
  /\ outcome' = [outcome EXCEPT ![writer] = "saved"]
  /\ pc' = [pc EXCEPT ![writer] = "release"]
  /\ UNCHANGED <<kind, owner>>

Release(writer) ==
  /\ owner = writer /\ pc[writer] = "release"
  /\ owner' = 0
  /\ pc' = [pc EXCEPT ![writer] = "done"]
  /\ UNCHANGED <<kind, revisions, values, committed, outcome>>

SeeBusyLock(writer) ==
  /\ pc[writer] = "waiting" /\ owner # 0
  /\ pc' = [pc EXCEPT ![writer] = "done"]
  /\ outcome' = [outcome EXCEPT ![writer] = "locked"]
  /\ UNCHANGED <<kind, owner, revisions, values, committed>>

AcquireFirst == Acquire(1)
AcquireSecond == Acquire(2)
CheckFirstRequest == FirstVersionCheck(1)
CheckSecondRequest == FirstVersionCheck(2)
RecheckFirstRequest == FinalVersionCheck(1)
RecheckSecondRequest == FinalVersionCheck(2)
RenameFirstConfiguration == RenameConfiguration(1)
RenameSecondConfiguration == RenameConfiguration(2)
ReleaseFirst == Release(1)
ReleaseSecond == Release(2)
FirstSeesBusyLock == SeeBusyLock(1)
SecondSeesBusyLock == SeeBusyLock(2)
Done == (\A writer \in Writers : pc[writer] = "done") /\ UNCHANGED vars

Next == AcquireFirst \/ AcquireSecond \/ CheckFirstRequest \/ CheckSecondRequest
        \/ RecheckFirstRequest \/ RecheckSecondRequest
        \/ RenameFirstConfiguration \/ RenameSecondConfiguration
        \/ ReleaseFirst \/ ReleaseSecond \/ FirstSeesBusyLock \/ SecondSeesBusyLock \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ kind \in Kinds
  /\ pc \in [Writers -> {"waiting", "check", "recheck", "rename", "release", "done"}]
  /\ owner \in {0, 1, 2}
  /\ revisions \in [Kinds -> 0..2]
  /\ values \in [alias : {"officialA", "officialB", "unmapped"},
                  status : {"active", "offShelf", "closed", "paused", "review"}]
  /\ committed \subseteq Writers
  /\ outcome \in [Writers -> {"pending", "saved", "conflict", "locked"}]

\* 同版请求最多一个保存成功，另一文件不被覆盖。
NoNewValueOverwrite ==
  /\ Cardinality(committed) <= 1
  /\ revisions[kind] = Cardinality(committed)
  /\ values[kind] = IF committed = {} THEN InitialValues[kind]
                    ELSE Proposal(kind, IF 1 \in committed THEN 1 ELSE 2)
  /\ \A file \in Kinds \ {kind} :
       (revisions[file] = 0 /\ values[file] = InitialValues[file])
=============================================================================
