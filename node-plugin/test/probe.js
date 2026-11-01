/**
 * Real-runtime security probe, mounted as its own patch row so it never ships
 * inside the qq profile:
 *
 *   node <dsh>/lib/bin.js --profile qq --patch test/probe.patch.yml
 *
 * It creates one non-owner and one owner agent through the live `agents`
 * service, prints how many tools each one sees, and then calls a real global
 * tool on the non-owner agent to capture the tool runtime's own denial.
 */
import { createQqAgent } from '../lib/session.js'

export const name = 'qq-probe'

export const inject = ['agents', 'tools']

const probeOptions = {
	cwd: process.cwd(),
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	nonOwnerPreset: '',
}

function describe(result) {
	if (result.isError !== true) return `isError=false value=${JSON.stringify(result.value).slice(0, 120)}`
	const text = (result.content ?? []).map((block) => block.text ?? `<${block.type}>`).join(' ')
	return `isError=true error.message=${JSON.stringify(result.error?.message)} content=${JSON.stringify(text)}`
}

export function apply(ctx) {
	ctx.effect(() => {
		let disposed = false
		const report = (line) => console.log(`[probe] ${line}`)

		const run = async () => {
			// The loop registers the agent factory from its own constructor; a
			// launcher-layer probe can run before that, so wait for boot to settle.
			await new Promise((resolve) => setTimeout(resolve, 3000))
			const globalNames = ctx.tools.schemas(undefined).map((schema) => schema.name)
			report(`global tool count=${globalNames.length} names=${globalNames.slice(0, 8).join(',')}`)

			const guest = await createQqAgent({ ctx, options: probeOptions, isOwner: false, log: (level, message) => console.log(`[probe] ${level}: ${message}`) })
			const guestNames = ctx.tools.schemas(guest.agent).map((schema) => schema.name)
			report(`non-owner agent=${guest.agent.id} visible tool count=${guestNames.length} names=${JSON.stringify(guestNames)}`)

			const owner = await createQqAgent({ ctx, options: probeOptions, isOwner: true, log: (level, message) => console.log(`[probe] ${level}: ${message}`) })
			const ownerNames = ctx.tools.schemas(owner.agent).map((schema) => schema.name)
			report(`owner agent=${owner.agent.id} visible tool count=${ownerNames.length} names=${ownerNames.slice(0, 6).join(',')}`)

			const sample = globalNames.find((toolName) => toolName !== 'run_code')
			for (const toolName of [sample, 'run_code']) {
				if (toolName === undefined) continue
				const result = await ctx.tools.execute({
					callId: `probe-${toolName}`,
					name: toolName,
					arguments: {},
					signal: AbortSignal.timeout(30_000),
					agent: guest.agent,
				})
				report(`non-owner call ${toolName} -> ${describe(result)}`)
			}

			guest.dispose()
			owner.dispose()
		}

		run()
			.catch((error) => report(`FAILED ${error?.stack ?? error}`))
			.finally(() => {
				if (!disposed) process.exit(0)
			})

		return () => {
			disposed = true
		}
	}, 'qq-probe')
}
