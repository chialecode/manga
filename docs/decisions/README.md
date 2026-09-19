# 决定与待决事项

| 入口 | 负责内容 |
| --- | --- |
| [已确认决定](confirmed-decisions.md) | A 编号索引、有效决定与职责正本 |
| [待决事项](open-questions.md) | 尚未解决的问题、技术选择及截止点 |
| [ADR-0001：建立文档治理框架](0001-document-governance.md) | 本次文档组织与治理选择 |
| [ADR-0002：本地验证优先的 GitHub 协作](0002-local-first-github.md) | 独立 Git 历史、必要 CI、单人维护 Ruleset 与低频操作 |
| [ADR-0007：采用 基础技术栈](0007-technology-stack.md) | accepted：UI、编辑、存储驱动及对应工程基础；集成待验证 |
| [ADR-0003：M0 UI/编辑实验基础](0003-m0-ui-editing.md) | superseded：原 textarea 推荐由 ADR-0007 替代 |
| [ADR-0004：存储、写入宿主与数据目录](0004-m0-storage-host.md) | 驱动已由 ADR-0007 替代；目录要求已确认；写入宿主仍 proposed |
| [ADR-0005：组合运行时](0005-m0-composition-runtime.md) | proposed：自研 kernel |
| [ADR-0006：媒体范围与性能建议](0006-m0-media-and-performance.md) | superseded：保留历史原型矩阵；当前格式目标见需求 |
| [决定模板](../templates/decision-record.md) | 后续重要技术/产品/治理决定 |

ADR 状态使用 proposed、accepted、superseded 或 rejected，记录决定者/来源、日期、候选、影响、验证和替代关系。登记表的 active/draft 等是文档治理状态，两者不能混用：一篇记录 rejected 方案的 ADR 可以作为 reference 保留。

用户选择、技术选择和原型结果分别记录。技术维护者可在已经授权的工程范围内作出合理决定；改变产品承诺须有用户或产品负责人的明确依据，不让 AI 自己产生“用户已确认”。未收到回复的可选问题保留假设及截止点，不视为默认同意。
