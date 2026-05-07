import type { K8sClients } from "./K8sClientFactory.js";

export type PodPhase =
	| "Pending"
	| "Running"
	| "Succeeded"
	| "Failed"
	| "Unknown";

function buildPodFailureError(
	podName: string,
	podStatus?: {
		initContainerStatuses?: Array<{
			name: string;
			state?: {
				terminated?: { exitCode?: number; reason?: string; message?: string };
			};
		}>;
		containerStatuses?: Array<{
			state?: { terminated?: { exitCode?: number; reason?: string } };
		}>;
	},
): Error {
	const initStatuses = podStatus?.initContainerStatuses || [];
	const containerStatuses = podStatus?.containerStatuses || [];

	const failedInit = initStatuses.find(
		(s) => s.state?.terminated && s.state.terminated.exitCode !== 0,
	);
	if (failedInit) {
		const t = failedInit.state?.terminated;
		const reason = t?.reason || "Unknown reason";
		const msg = t?.message ? `: ${t.message}` : "";
		return new Error(
			`Pod ${podName} init container "${failedInit.name}" failed: ${reason} (exit ${t?.exitCode})${msg}`,
		);
	}

	const terminatedState = containerStatuses[0]?.state?.terminated;
	const reason = terminatedState?.reason || "Unknown reason";
	return new Error(`Pod ${podName} failed: ${reason}`);
}

/**
 * Waits for a pod to reach a target phase.
 * Polls the pod status at regular intervals until the target phase is reached or timeout.
 */
export function waitForPodPhase(
	clients: K8sClients,
	podName: string,
	namespace: string,
	targetPhases: PodPhase[],
	timeoutMs: number,
	pollIntervalMs = 2000,
): Promise<PodPhase> {
	const startTime = Date.now();

	function poll(): Promise<PodPhase> {
		if (Date.now() - startTime > timeoutMs) {
			return Promise.reject(
				new Error(
					`Timed out waiting for pod ${podName} to reach phase [${targetPhases.join(", ")}]`,
				),
			);
		}

		return clients.coreApi
			.readNamespacedPod({ name: podName, namespace })
			.then((pod) => {
				const phase = (pod.status?.phase || "Unknown") as PodPhase;

				if (targetPhases.includes(phase)) {
					return phase;
				}

				if (phase === "Failed") {
					return Promise.reject(buildPodFailureError(podName, pod.status));
				}

				return new Promise<PodPhase>((resolve) => {
					setTimeout(() => resolve(poll()), pollIntervalMs);
				});
			});
	}

	return poll();
}

/**
 * Waits for a pod to complete. Only targets "Succeeded" so that
 * "Failed" hits the early-exit handler in waitForPodPhase.
 */
export function waitForPodCompletion(
	clients: K8sClients,
	podName: string,
	namespace: string,
	timeoutMs: number,
	pollIntervalMs = 2000,
): Promise<PodPhase> {
	return waitForPodPhase(
		clients,
		podName,
		namespace,
		["Succeeded"],
		timeoutMs,
		pollIntervalMs,
	);
}

/**
 * Waits for a pod to be fully deleted (404 from the API).
 * Used before recreating a pod with the same name to avoid 409 Conflict.
 */
export function waitForPodDeletion(
	clients: K8sClients,
	podName: string,
	namespace: string,
	timeoutMs: number,
	pollIntervalMs = 2000,
): Promise<void> {
	const startTime = Date.now();

	function poll(): Promise<void> {
		if (Date.now() - startTime > timeoutMs) {
			return Promise.reject(
				new Error(`Timed out waiting for pod ${podName} to be deleted`),
			);
		}

		return clients.coreApi
			.readNamespacedPod({ name: podName, namespace })
			.then(() => {
				return new Promise<void>((resolve) => {
					setTimeout(() => resolve(poll()), pollIntervalMs);
				});
			})
			.catch((error: Error & { statusCode?: number; code?: number }) => {
				const status = error.statusCode ?? error.code;
				if (status === 404) {
					return;
				}
				return Promise.reject(error);
			});
	}

	return poll();
}

/**
 * Waits for a pod to be ready (Running phase with containers ready).
 * Used for persistent pods before executing commands.
 */
export function waitForPodReady(
	clients: K8sClients,
	podName: string,
	namespace: string,
	timeoutMs: number,
	pollIntervalMs = 2000,
): Promise<PodPhase> {
	const startTime = Date.now();

	function poll(): Promise<PodPhase> {
		if (Date.now() - startTime > timeoutMs) {
			return Promise.reject(
				new Error(`Timed out waiting for pod ${podName} to be ready`),
			);
		}

		return clients.coreApi
			.readNamespacedPod({ name: podName, namespace })
			.then((pod) => {
				const phase = (pod.status?.phase || "Unknown") as PodPhase;

				if (phase === "Failed") {
					return Promise.reject(buildPodFailureError(podName, pod.status));
				}

				if (phase === "Running") {
					const containers = pod.status?.containerStatuses || [];
					const allReady =
						containers.length > 0 && containers.every((c) => c.ready);
					if (allReady) {
						return "Running" as PodPhase;
					}
				}

				return new Promise<PodPhase>((resolve) => {
					setTimeout(() => resolve(poll()), pollIntervalMs);
				});
			});
	}

	return poll();
}
