# Mirror

TLC reached 96 states and 480 steps. The chart draws 8 states and 13 arrows.
The chart does not draw 332 steps that stay in one chart state.

## NoViewportDispatchAfterRisk breaks
The shortest path has 3 steps:
0. 未熔断 可以自动维护
1. 入口检查后开始视口还原: 首条视口命令等待返回
2. 观察到风险页: 已熔断 首条视口命令仍在途
3. 首条返回后继续发送清除命令: 熔断后仍发出下一条还原命令

## Rules that hold
TypeOK, FirstRiskIsRetained, NoMaintenanceAdmittedInRisk, NoDeadlock
