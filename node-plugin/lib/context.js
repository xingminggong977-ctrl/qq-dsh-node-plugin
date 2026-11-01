import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 谁在说话、在哪个场景说话——工具自己也该知道。
 *
 * 会话级限制（非主人一律无工具）由 `lockdownTools` 在 setup 时定死；但有一类
 * 危险不是「没有权限」而是「场景不对」：主人本人在群里时同样有全套工具，
 * 而群里还有别人在说话。发说说、删说说这类动作一旦落到群里，就是**以主人
 * 的名义对公众发声**，代价不可逆。
 *
 * 工具拿不到会话对象，所以把当轮场景放进来：`runTask` 在调用 `followup` 前
 * 设置，工具在自己的执行链里读取。没有场景（比如被调度器直接调起来）按
 * 「不是主人的私聊」处理——默认拒绝，而不是默认放行。
 */
const storage = new AsyncLocalStorage()

/**
 * @param scope - `{ group, isOwner }`：这一轮在哪个场景、谁在说话。
 * @param fn - 在这一轮的异步链里执行的动作。
 */
export function runInTaskScope(scope, fn) {
	return storage.run({ group: scope?.group === true, isOwner: scope?.isOwner === true }, fn)
}

/** 当前轮次的场景；不在任何一轮里时返回 null。 */
export function currentTaskScope() {
	return storage.getStore() ?? null
}

/** 只有「主人 + 私聊」才允许留下公开痕迹。 */
export function isPrivateOwnerTurn() {
	const scope = storage.getStore()
	return scope !== undefined && scope.group === false && scope.isOwner === true
}
