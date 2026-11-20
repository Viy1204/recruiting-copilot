---------------------------- MODULE Decisions ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

\* 来源：skills/recruit-board/decisions-domain.mjs applyDecision:120-129、203；
\* scripts/decisions.mjs applyDecisionCommand:66-99、readDecision:41。
\* 起点是公开 register 已成功后的 revision 1；省略注册历史项。
\* 两位客户端各有一个 evidence 请求；拒绝后可重读，成功后可重放。
\* 一次 applyDecision 纯域转换是一步。正常存储入口持有单事项锁；
\* 不将来源 run、事项 JSON、known 标记等跨文件写视为全局原子操作。
Clients == {"A", "B"}
VARIABLES revision, history, current, snapshot
vars == <<revision, history, current, snapshot>>

Init == /\ revision = 1
        /\ history = <<>>
        /\ current = "initial"
        /\ snapshot = [client \in Clients |-> 1]

Accepted == {history[i].request : i \in 1..Len(history)}

ReadCurrent ==
  \E client \in Clients \ Accepted :
    /\ snapshot[client] # revision
    /\ snapshot' = [snapshot EXCEPT ![client] = revision]
    /\ UNCHANGED <<revision, history, current>>

ApplyEvidence ==
  \E client \in Clients \ Accepted :
    /\ revision < 3
    /\ snapshot[client] = revision
    /\ revision' = revision + 1
    /\ history' = Append(history, [request |-> client,
                                   expected |-> snapshot[client], base |-> revision])
    /\ current' = client
    /\ UNCHANGED snapshot

RejectStale ==
  /\ \E client \in Clients \ Accepted : snapshot[client] # revision
  /\ UNCHANGED vars

\* requestId 的回执查询先于 expectedRevision 检查，旧请求返回当前记录。
ReplayRequest == /\ Accepted # {} /\ UNCHANGED vars
RejectRequestConflict == /\ Accepted # {} /\ UNCHANGED vars
Done == /\ Len(history) = 2 /\ UNCHANGED vars

Next == ReadCurrent \/ ApplyEvidence \/ RejectStale \/ ReplayRequest
        \/ RejectRequestConflict \/ Done

TypeOK ==
  /\ revision \in 1..3
  /\ history \in UNION {[1..n -> [request : Clients, expected : 1..2, base : 1..2]] : n \in 0..2}
  /\ current \in Clients \cup {"initial"}
  /\ snapshot \in [Clients -> 1..3]

\* base 是观察量：记录此次转换前的真实版本，不是客户端自报值。
\* current 投影最后一条新增依据，历史中的注册项不计入此界限。
DecisionWritesAreProtected ==
  /\ revision = 1 + Len(history)
  /\ Cardinality(Accepted) = Len(history)
  /\ \A i \in 1..Len(history) :
       /\ history[i].expected = history[i].base
       /\ history[i].base = i
  /\ current = IF Len(history) = 0 THEN "initial" ELSE history[Len(history)].request
=============================================================================
