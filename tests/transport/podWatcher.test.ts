import { describe, it, expect, vi } from "vitest";
import {
	waitForPodPhase,
	waitForPodCompletion,
	waitForPodDeletion,
	waitForPodReady,
} from "../../nodes/ClaudeCode/transport/k8s/podWatcher.js";
import type { K8sClients } from "../../nodes/ClaudeCode/transport/k8s/K8sClientFactory.js";

function buildMockClients(
	podSequence: Array<Record<string, unknown> | Error>,
): K8sClients {
	let callIndex = 0;
	return {
		coreApi: {
			readNamespacedPod: vi.fn().mockImplementation(() => {
				const entry =
					podSequence[Math.min(callIndex++, podSequence.length - 1)];
				if (entry instanceof Error) {
					return Promise.reject(entry);
				}
				return Promise.resolve(entry);
			}),
			deleteNamespacedPod: vi.fn().mockResolvedValue({}),
		},
	} as unknown as K8sClients;
}

function pod(
	phase: string,
	extras?: {
		initContainerStatuses?: Array<Record<string, unknown>>;
		containerStatuses?: Array<Record<string, unknown>>;
	},
) {
	return {
		status: {
			phase,
			...(extras?.initContainerStatuses && {
				initContainerStatuses: extras.initContainerStatuses,
			}),
			...(extras?.containerStatuses && {
				containerStatuses: extras.containerStatuses,
			}),
		},
	};
}

describe("podWatcher", () => {
	describe("waitForPodCompletion", () => {
		it("resolves with Succeeded when pod completes normally", async () => {
			const clients = buildMockClients([
				pod("Pending"),
				pod("Running"),
				pod("Succeeded"),
			]);

			const result = await waitForPodCompletion(
				clients,
				"test-pod",
				"default",
				10000,
				10,
			);
			expect(result).toBe("Succeeded");
		});

		it("rejects when pod fails — regression test for dead-code bug", async () => {
			// Before the fix, "Failed" was in targetPhases, so waitForPodPhase
			// resolved with "Failed" instead of rejecting. The downstream executor
			// then tried to read logs from a never-started container → HTTP 400.
			const clients = buildMockClients([
				pod("Pending"),
				pod("Failed", {
					containerStatuses: [
						{
							state: {
								terminated: { exitCode: 1, reason: "Error" },
							},
						},
					],
				}),
			]);

			await expect(
				waitForPodCompletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow("test-pod failed: Error");
		});

		it("surfaces init container failure with name and exit code", async () => {
			const clients = buildMockClients([
				pod("Failed", {
					initContainerStatuses: [
						{
							name: "git-clone",
							state: {
								terminated: {
									exitCode: 128,
									reason: "Error",
									message: "repository not found",
								},
							},
						},
					],
					containerStatuses: [],
				}),
			]);

			await expect(
				waitForPodCompletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow(
				'init container "git-clone" failed: Error (exit 128): repository not found',
			);
		});

		it("reports init container failure over main container failure", async () => {
			// When both init and main containers have terminated states,
			// init container should be reported since it ran first
			const clients = buildMockClients([
				pod("Failed", {
					initContainerStatuses: [
						{
							name: "setup",
							state: { terminated: { exitCode: 1, reason: "OOMKilled" } },
						},
					],
					containerStatuses: [
						{
							state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
						},
					],
				}),
			]);

			await expect(
				waitForPodCompletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow('init container "setup" failed: OOMKilled (exit 1)');
		});

		it("falls through to main container when init containers all succeeded", async () => {
			const clients = buildMockClients([
				pod("Failed", {
					initContainerStatuses: [
						{
							name: "git-clone",
							state: { terminated: { exitCode: 0, reason: "Completed" } },
						},
					],
					containerStatuses: [
						{
							state: {
								terminated: { exitCode: 2, reason: "AppError" },
							},
						},
					],
				}),
			]);

			await expect(
				waitForPodCompletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow("test-pod failed: AppError");
		});

		it("handles Failed pod with no container statuses at all", async () => {
			const clients = buildMockClients([pod("Failed")]);

			await expect(
				waitForPodCompletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow("test-pod failed: Unknown reason");
		});

		it("times out if pod stays Pending", async () => {
			const clients = buildMockClients([pod("Pending")]);

			await expect(
				waitForPodCompletion(clients, "stuck-pod", "default", 100, 10),
			).rejects.toThrow("Timed out waiting for pod stuck-pod");
		});
	});

	describe("waitForPodPhase", () => {
		it("resolves immediately when pod is already at target phase", async () => {
			const clients = buildMockClients([pod("Running")]);

			const result = await waitForPodPhase(
				clients,
				"test-pod",
				"default",
				["Running"],
				10000,
			);
			expect(result).toBe("Running");
		});

		it("polls until target phase is reached", async () => {
			const clients = buildMockClients([
				pod("Pending"),
				pod("Pending"),
				pod("Running"),
			]);

			const result = await waitForPodPhase(
				clients,
				"test-pod",
				"default",
				["Running"],
				10000,
				10, // fast poll for test speed
			);
			expect(result).toBe("Running");
			expect(clients.coreApi.readNamespacedPod).toHaveBeenCalledTimes(3);
		});

		it("rejects on Failed even when not in targetPhases", async () => {
			const clients = buildMockClients([
				pod("Failed", {
					containerStatuses: [
						{
							state: { terminated: { exitCode: 1, reason: "CrashLoop" } },
						},
					],
				}),
			]);

			await expect(
				waitForPodPhase(clients, "test-pod", "default", ["Running"], 10000),
			).rejects.toThrow("test-pod failed: CrashLoop");
		});

		it("treats missing phase as Unknown", async () => {
			const clients = buildMockClients([{ status: {} }, pod("Succeeded")]);

			const result = await waitForPodPhase(
				clients,
				"test-pod",
				"default",
				["Succeeded", "Unknown"],
				10000,
				10,
			);
			expect(result).toBe("Unknown");
		});
	});

	describe("waitForPodDeletion", () => {
		it("resolves when pod returns 404", async () => {
			const notFound = Object.assign(new Error("Not Found"), {
				statusCode: 404,
			});
			const clients = buildMockClients([pod("Running"), notFound]);

			await expect(
				waitForPodDeletion(clients, "test-pod", "default", 10000, 10),
			).resolves.toBeUndefined();
		});

		it("times out if pod never goes away", async () => {
			const clients = buildMockClients([pod("Running")]);

			await expect(
				waitForPodDeletion(clients, "test-pod", "default", 100, 10),
			).rejects.toThrow("Timed out waiting for pod test-pod to be deleted");
		});

		it("propagates non-404 API errors", async () => {
			const forbidden = Object.assign(new Error("Forbidden"), {
				statusCode: 403,
			});
			const clients = buildMockClients([forbidden]);

			await expect(
				waitForPodDeletion(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow("Forbidden");
		});
	});

	describe("waitForPodReady", () => {
		it("resolves when pod is Running with all containers ready", async () => {
			const clients = buildMockClients([
				pod("Pending"),
				pod("Running", {
					containerStatuses: [{ ready: false }],
				}),
				pod("Running", {
					containerStatuses: [{ ready: true }],
				}),
			]);

			const result = await waitForPodReady(
				clients,
				"test-pod",
				"default",
				10000,
				10,
			);
			expect(result).toBe("Running");
		});

		it("rejects if pod fails before becoming ready", async () => {
			const clients = buildMockClients([
				pod("Pending"),
				pod("Failed", {
					initContainerStatuses: [
						{
							name: "git-clone",
							state: { terminated: { exitCode: 1, reason: "Error" } },
						},
					],
				}),
			]);

			await expect(
				waitForPodReady(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow('init container "git-clone" failed: Error (exit 1)');
		});

		it("rejects with generic message when Failed with no statuses", async () => {
			const clients = buildMockClients([pod("Failed")]);

			await expect(
				waitForPodReady(clients, "test-pod", "default", 10000, 10),
			).rejects.toThrow("test-pod failed: Unknown reason");
		});

		it("waits for ALL containers to be ready, not just one", async () => {
			const clients = buildMockClients([
				pod("Running", {
					containerStatuses: [{ ready: true }, { ready: false }],
				}),
				pod("Running", {
					containerStatuses: [{ ready: true }, { ready: true }],
				}),
			]);

			const result = await waitForPodReady(
				clients,
				"test-pod",
				"default",
				10000,
				10,
			);
			expect(result).toBe("Running");
			expect(clients.coreApi.readNamespacedPod).toHaveBeenCalledTimes(2);
		});
	});
});
