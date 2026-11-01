/**
 * Single entry point for the whole suite:
 *
 *   node --import ./test/dsh-resolve.js --test test/index.js
 *
 * Node 24 reads a positional argument to `--test` as a file path, so the
 * directory form `node --test test/` dies with ERR_UNSUPPORTED_DIR_IMPORT
 * ("Directory import ... is not supported") before a single test runs. Passing
 * this file instead keeps the run to one process and makes the suite list
 * explicit: the fixtures that live beside the tests — bridge-stub.js,
 * fake-runtime.js, stub-server.js and probe.js (a cordis plugin for the live
 * security probe, not a test) — stay out by construction rather than by a
 * file-naming convention.
 *
 * Adding a suite: import it here. Nothing else needs to change.
 */
import './persona.test.js'
import './session-rotate.test.js'
import './acceptance.js'
import './groups.test.js'
import './protocol-v2.test.js'
import './turn-timeout.test.js'
import './early-reply.test.js'
import './tool-budget.test.js'
import './qzone.test.js'
import './memory.test.js'
import './audit.test.js'
import './correction.test.js'
import './recall.test.js'
import './knowledge.test.js'
import './remember.test.js'
import './remind.test.js'
import './send-file.test.js'
import './tier.test.js'
import './audit-wiring.test.js'
import './proactive.test.js'
import './nonowner-rules.test.js'
import './pc-tools.test.js'
import './nightly.test.js'
import './nightly-verify.test.js'
import './reply-guard.test.js'
import './world-life.test.js'
import './qzone-notes.test.js'
