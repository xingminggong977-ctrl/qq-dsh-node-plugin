/**
 * Decide how hard the model should think about one incoming message.
 *
 * The agent runtime fixes its reasoning effort per Agent, not per turn, so the
 * only honest way to spend less on "在吗" is to classify the message and, when
 * the answer is `light`, drop the effort override for that turn (the provider
 * then uses its own default, which is cheaper than the configured `max`).
 * Classification is a heuristic on purpose: it is cheap, explainable, and the
 * wrong answer costs latency, never correctness.
 */

/** Cheapest tier: no reasoning-effort override for this turn. */
export const TIER_LIGHT = 'light'

/** Full tier: the configured `reasoningEffort`. */
export const TIER_HEAVY = 'heavy'

/** Tiering is off by default so behaviour only changes when asked for. */
export const TIER_DEFAULTS = Object.freeze({ enabled: false, lightMaxChars: 40 })

/**
 * Words that mean "this wants work done". A short message carrying one of these
 * is heavy even when it is short: 帮我改一下 is nine characters and an entire task.
 */
const WORK_HINTS = /帮|做|改|写|查|搜|找|算|翻译|整理|总结|学|背|记(下|得)|发|删|建|装|跑|分析|对比|规划|看看这|解决|检查|优化|解释|为什么|怎么(弄|办|做)/u

/**
 * Classify one message.
 *
 * @param text - the message body as delivered by the bridge.
 * @param options.enabled - tiering switch; a disabled classifier always answers `heavy`.
 * @param options.lightMaxChars - longest message still eligible for the light tier.
 * @param options.hasImages - an image is always treated as work: "看看这个" is a task.
 * @param options.isGroupContextOnly - a group message that does not need a reply runs no turn,
 *   so its tier is irrelevant; `light` keeps the intent explicit.
 * @returns {@link TIER_LIGHT} or {@link TIER_HEAVY}.
 */
export function tierOf(text, { enabled = false, lightMaxChars = TIER_DEFAULTS.lightMaxChars, hasImages = false, isGroupContextOnly = false } = {}) {
	if (!enabled) return TIER_HEAVY
	if (isGroupContextOnly) return TIER_LIGHT
	if (hasImages) return TIER_HEAVY
	const trimmed = typeof text === 'string' ? text.trim() : ''
	if (trimmed === '') return TIER_LIGHT
	// Spread so an emoji counts as one character rather than two.
	if ([...trimmed].length > lightMaxChars) return TIER_HEAVY
	if (WORK_HINTS.test(trimmed)) return TIER_HEAVY
	return TIER_LIGHT
}
