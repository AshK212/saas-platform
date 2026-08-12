import { PLATFORM_NAME } from '@hybrid/contracts';

/**
 * Reference client / simulator - executable skeleton.
 *
 * FUTURE ROLE
 * -----------
 * This application becomes the reference client used to demonstrate the Credit
 * acceptance flows end to end: it will register as an agent, emit events to the
 * control plane, and call the precheck surface before acting.
 *
 * AUTHORITY BOUNDARY
 * ------------------
 * The simulator is an ordinary API client with no privileged standing. It must
 * never be granted operator policy-mutation authority: it cannot create, edit
 * or lift caps, pauses or policies. It asks; the control plane decides.
 *
 * STEP 1 SCOPE
 * ------------
 * Compiles and runs. No event generation, no acceptance scenarios, no network
 * calls - those belong to the dedicated simulator step.
 */
function main(): void {
  // eslint-disable-next-line no-console -- the simulator is a CLI; stdout is its interface
  console.log(`[simulator] ${PLATFORM_NAME} reference client - Step 1 skeleton, no scenarios implemented.`);
}

main();
