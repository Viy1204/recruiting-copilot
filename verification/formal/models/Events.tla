------------------------------ MODULE Events ------------------------------
EXTENDS Naturals

\* 来源：skills/recruit-board/scripts/progress.mjs recordProgress:47-60、68-74；
\* scripts/events.mjs readArchiveEvents:61-95、recordCandidateEvent:98-142；
\* model.mjs transitionRun highlight:430、summary:457、complete:482。
\* 固定一名有 calendar 收据的候选人；所有步骤已经完成或有理由跳过。
\* 关联台账/档案身份固定。一次读到并校验的单档案缓冲区归类为 archive。
\* 档案发布、档案回读、内存检查/转换、run 文件发布各是独立动作。
\* 允许档案在回读后或 run 完成后变化；不假设跨文件事务。
ArchiveStates == {"missing", "unlinked", "other_run", "linked", "invalid", "unavailable"}
Phases == {"ready", "observed", "checked", "staged", "completed"}
VARIABLES phase, archive, observed
vars == <<phase, archive, observed>>

Init == /\ phase = "ready"
        /\ archive = "missing"
        /\ observed = "not_read"

\* 环境动作：单档案的事件写入、人工编辑、损坏、删除或恢复。
\* linked 仅表示有同候选人且来源 run 相同的有效事件，无坏记录/读取错误。
ArchiveChanges == /\ archive' \in ArchiveStates
                  /\ UNCHANGED <<phase, observed>>

ReadArchive == /\ phase = "ready"
               /\ observed' = archive
               /\ phase' = "observed"
               /\ UNCHANGED archive

RejectMissingEvent == /\ phase = "observed"
                      /\ observed # "linked"
                      /\ phase' = "ready"
                      /\ observed' = "not_read"
                      /\ UNCHANGED archive

ApproveArchive == /\ phase = "observed"
                  /\ observed = "linked"
                  /\ phase' = "checked"
                  /\ UNCHANGED <<archive, observed>>

\* 对已读取 run 执行同步的 highlight/complete 域转换，不发布档案。
StageCompletion == /\ phase = "checked"
                   /\ phase' = "staged"
                   /\ UNCHANGED <<archive, observed>>

PublishCompletion == /\ phase = "staged"
                     /\ phase' = "completed"
                     /\ UNCHANGED <<archive, observed>>

Done == /\ phase = "completed" /\ UNCHANGED vars
Next == ArchiveChanges \/ ReadArchive \/ RejectMissingEvent \/ ApproveArchive
        \/ StageCompletion \/ PublishCompletion \/ Done

TypeOK == /\ phase \in Phases
          /\ archive \in ArchiveStates
          /\ observed \in ArchiveStates \cup {"not_read"}

\* 只承诺收尾前确实观察到合格事件，不承诺档案之后永不被删除。
CalendarCompletionHasObservedEvent == phase = "completed" => observed = "linked"
=============================================================================
