----------------------------- MODULE Materials -----------------------------
EXTENDS Naturals, FiniteSets

\* materials.mjs:195、259 共用 locked(...)，底层为 storage.mjs:55-94。
\* 两个请求携带相同清单 revision 0；哈希抽象为不可分的版本代号。
\* 原件发布 link(:246) 与清单 rename(:190) 是独立步骤。
Writers == {"set", "import"}
VARIABLES pc, owner, revision, captured, files, archived, committed, outcome
vars == <<pc, owner, revision, captured, files, archived, committed, outcome>>

Init ==
  /\ pc = [writer \in Writers |-> "waiting"]
  /\ owner = "none"
  /\ revision = 0
  /\ captured = [writer \in Writers |-> 0]
  /\ files = "old"
  /\ archived = FALSE
  /\ committed = {}
  /\ outcome = [writer \in Writers |-> "pending"]

\* 成功创建硬链接是取得写锁的时刻。
Acquire(writer) ==
  /\ pc[writer] = "waiting" /\ owner = "none"
  /\ owner' = writer
  /\ pc' = [pc EXCEPT ![writer] = "check"]
  /\ UNCHANGED <<revision, captured, files, archived, committed, outcome>>

\* materials.mjs:202-203、272-273 比较调用方版本与当前文件版本。
CheckRevision(writer) ==
  /\ owner = writer /\ pc[writer] = "check"
  /\ captured' = [captured EXCEPT ![writer] = revision]
  /\ pc' = [pc EXCEPT ![writer] = IF revision = 0 THEN "prepare" ELSE "release"]
  /\ outcome' = IF revision = 0 THEN outcome
                ELSE [outcome EXCEPT ![writer] = "conflict"]
  /\ UNCHANGED <<owner, revision, files, archived, committed>>

\* 这里只观察持久归档 link；复制和同步临时内容为内部步骤。
\* 归档这一步绝不改变资料映射清单。
PublishImportedOriginal ==
  /\ owner = "import" /\ pc["import"] = "prepare"
  /\ archived' = TRUE
  /\ pc' = [pc EXCEPT !["import"] = "archived"]
  /\ UNCHANGED <<owner, revision, captured, files, committed, outcome>>

\* 原件发布与清单提交之间失败，可以留下未关联原件。
InterruptImport ==
  /\ owner = "import" /\ pc["import"] = "archived"
  /\ pc' = [pc EXCEPT !["import"] = "release"]
  /\ outcome' = [outcome EXCEPT !["import"] = "interrupted"]
  /\ UNCHANGED <<owner, revision, captured, files, archived, committed>>

\* commitMapping:175、189 复核本次读取的版本，不是调用方旧版本。
\* 异步准备不是事务；最后检查与 rename 仍是独立步骤。
RecheckMapping(writer) ==
  /\ owner = writer
  /\ pc[writer] = IF writer = "set" THEN "prepare" ELSE "archived"
  /\ pc' = [pc EXCEPT ![writer] = IF revision = captured[writer]
                                THEN "rename" ELSE "release"]
  /\ outcome' = IF revision = captured[writer] THEN outcome
                ELSE [outcome EXCEPT ![writer] = "conflict"]
  /\ UNCHANGED <<owner, revision, captured, files, archived, committed>>

\* 唯一清单提交点为 :190 的 rename(temporary, current.file)。
RenameMapping(writer) ==
  /\ owner = writer /\ pc[writer] = "rename"
  /\ revision' = revision + 1
  /\ files' = IF writer = "set" THEN "selected" ELSE "imported"
  /\ committed' = committed \cup {writer}
  /\ outcome' = [outcome EXCEPT ![writer] = "saved"]
  /\ pc' = [pc EXCEPT ![writer] = "release"]
  /\ UNCHANGED <<owner, captured, archived>>

\* withItemLock 的 finally 只释放本次取得的锁。
Release(writer) ==
  /\ owner = writer /\ pc[writer] = "release"
  /\ owner' = "none"
  /\ pc' = [pc EXCEPT ![writer] = "done"]
  /\ UNCHANGED <<revision, captured, files, archived, committed, outcome>>

SeeBusyLock(writer) ==
  /\ pc[writer] = "waiting" /\ owner # "none"
  /\ pc' = [pc EXCEPT ![writer] = "done"]
  /\ outcome' = [outcome EXCEPT ![writer] = "locked"]
  /\ UNCHANGED <<owner, revision, captured, files, archived, committed>>

AcquireSet == Acquire("set")
AcquireImport == Acquire("import")
CheckSetRevision == CheckRevision("set")
CheckImportRevision == CheckRevision("import")
RecheckSetMapping == RecheckMapping("set")
RecheckImportMapping == RecheckMapping("import")
RenameSetMapping == RenameMapping("set")
RenameImportMapping == RenameMapping("import")
ReleaseSet == Release("set")
ReleaseImport == Release("import")
SetSeesBusyLock == SeeBusyLock("set")
ImportSeesBusyLock == SeeBusyLock("import")
Done == (\A writer \in Writers : pc[writer] = "done") /\ UNCHANGED vars

Next == AcquireSet \/ AcquireImport \/ CheckSetRevision \/ CheckImportRevision
        \/ PublishImportedOriginal \/ InterruptImport
        \/ RecheckSetMapping \/ RecheckImportMapping
        \/ RenameSetMapping \/ RenameImportMapping
        \/ ReleaseSet \/ ReleaseImport \/ SetSeesBusyLock \/ ImportSeesBusyLock \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ pc \in [Writers -> {"waiting", "check", "prepare", "archived", "rename", "release", "done"}]
  /\ owner \in Writers \cup {"none"}
  /\ revision \in 0..2
  /\ captured \in [Writers -> 0..2]
  /\ files \in {"old", "selected", "imported"}
  /\ archived \in BOOLEAN
  /\ committed \subseteq Writers
  /\ outcome \in [Writers -> {"pending", "saved", "conflict", "locked", "interrupted"}]

\* 旧表单或旧导入不能抹掉同版请求已保存的新映射。
NoStaleMappingOverwrite ==
  /\ Cardinality(committed) <= 1
  /\ revision = Cardinality(committed)
  /\ files = IF committed = {} THEN "old"
              ELSE IF "set" \in committed THEN "selected" ELSE "imported"
  /\ (files = "imported" => archived)
=============================================================================
