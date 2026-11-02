import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every outbound utterance she makes lands in one append-only JSONL file per
 * month. The point is not debugging but accountability: if she posts something
 * to QQ 空间 or says something in a group, a line here proves what, where and
 * when, long after the journal has rotated.
 */

/** Longest slice of the spoken text kept in one line; longer replies are truncated. */
export const AUDIT_MAX_TEXT = 2000

/** Record kinds; every outbound utterance maps to exactly one. */
export const AUDIT_KINDS = Object.freeze(['private_reply', 'group_reply', 'proactive', 'qzone_post', 'qzone_delete', 'memory_write'])

/**
 * Monthly file name, UTC based so a timezone change cannot rewrite history
 * into a different month.
 * @param date - the moment the line was written.
 */
export function auditFileName(date) {
	const year = date.getUTCFullYear()
	const month = String(date.getUTCMonth() + 1).padStart(2, '0')
	return `audit-${year}-${month}.jsonl`
}

/**
 * Build the audit sink.
 *
 * An empty `dir` disables auditing and makes `record` a no-op: a missing audit
 * trail must never be the reason the bot stops answering. A write failure warns
 * exactly once — a full disk would otherwise produce one warning per reply.
 *
 * @param options.dir - directory for the monthly files; empty disables.
 * @param options.log - diagnostic sink, `(level, message)`.
 * @param options.now - clock, injectable for the month-rollover test.
 * @param options.write - file writer, injectable so the failure path is testable.
 */
export function createAuditLog({ dir = '', log = () => {}, now = () => new Date(), write = appendFileSync } = {}) {
	const target = String(dir ?? '').trim()
	if (target === '') return Object.freeze({ dir: '', disabled: true, record: () => false })
	let warned = false
	/**
	 * Append one record. Never throws and never rejects.
	 * @param entry.kind - one of {@link AUDIT_KINDS}; anything else is stored as `unknown`.
	 * @param entry.target - QQ number, group number, or `qzone`.
	 * @param entry.text - what was actually said.
	 * @param entry.tier - thinking tier that produced it, when tiering is on.
	 * @param entry.taskId - protocol task that produced it, when there is one.
	 * @param entry.needsReply - the turn was expected to answer, even if it answered nothing.
	 * @param entry.isOwner - the person on the other side is the owner.
	 * @returns whether the line reached the file.
	 */
	function record(entry) {
		const text = typeof entry?.text === 'string' ? entry.text : ''
		const at = now()
		const line = {
			at: at.toISOString(),
			kind: AUDIT_KINDS.includes(entry?.kind) ? entry.kind : 'unknown',
			ok: entry?.ok !== false,
			target: String(entry?.target ?? ''),
			chars: text.length,
			text: text.length > AUDIT_MAX_TEXT ? text.slice(0, AUDIT_MAX_TEXT) : text,
			...(text.length > AUDIT_MAX_TEXT ? { truncated: true } : {}),
			...(typeof entry?.tier === 'string' && entry.tier !== '' ? { tier: entry.tier } : {}),
			...(typeof entry?.taskId === 'string' && entry.taskId !== '' ? { taskId: entry.taskId } : {}),
			...(entry?.needsReply === true ? { needsReply: true } : {}),
			...(entry?.isOwner === true ? { isOwner: true } : {}),
		}
		try {
			mkdirSync(target, { recursive: true })
			write(join(target, auditFileName(at)), `${JSON.stringify(line)}\n`, 'utf8')
			return true
		} catch (error) {
			if (!warned) {
				warned = true
				log('warn', `qq-node: audit write failed (${error?.message ?? String(error)}); later failures stay silent`)
			}
			return false
		}
	}
	return Object.freeze({ dir: target, disabled: false, record })
}
