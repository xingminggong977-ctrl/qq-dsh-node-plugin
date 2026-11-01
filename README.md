# qq-dsh-node-plugin

把 QQ 变成 DSH 的一个会话界面：一个 `qq-node` 插件，负责轮询桥接、跑回合、写记忆、做夜班。

这个仓库同时是**部署布局**：`node-plugin/` 是插件包，`persona/` 是它读的人格与记忆目录
（插件按「包的上一级 + `persona`」定位，所以两者要平级）。

```
node-plugin/     插件包（package.json 在这里，npm test 在这里跑）
persona/         人格、记忆、规矩、日记（只放模板，运行时数据不入库）
```

## 装

```bash
cd node-plugin && npm install && npm test
```

把它挂进 DSH profile 的 `package.json`：

```json
"qq-node": "link:/path/to/repo/node-plugin"
```

然后照着 `persona/PERSONA.md` 写你自己的人格。`MEMORY.md`、`CORRECTIONS.md`、`diary/`
第一次写入时由插件自己建。

## 它做什么

| 工具 | 用途 |
| --- | --- |
| `remember` / `recall` | 写长期记忆、按需翻旧账 |
| `qq_send_file` | 把她做好的文件发给主人 |
| `remind` | 「明天七点提醒我」落库，到点由桥直接推 |
| `qzone_send` | 发 QQ 空间 |
| `pc_exec` / `pc_read` / `pc_write` | 够得到主人电脑上的一小块（需显式开启） |

还有几件不做成工具的事：每轮回合的 persona 装配与预算、注入不等于复习的记忆衰减、
工具预算与超时保话、夜班 digest 与提案。细节和全部配置项见 [`node-plugin/README.md`](node-plugin/README.md)。

## 隐私边界

主人的长期记忆、规矩、日记只注入主人自己的私聊；别人跟它说话时，只有人格与公共知识。
别人连工具都拿不到——非主人的会话在装配时就被换成 empty preset。

## 许可

MIT。
