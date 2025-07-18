import { PassThrough } from "node:stream";

import * as k8s from "@kubernetes/client-node";
import {
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	NodeOperationError,
} from "n8n-workflow";

// Helper types
interface SafePromiseHandlers {
	safeResolve: (value: any) => void;
	safeReject: (err: any) => void;
}

interface LogOptions {
	follow?: boolean;
	tailLines?: number;
	pretty?: boolean;
	timestamps?: boolean;
	sinceTime?: string;
}

export class K8SClient {
	kubeConfig: k8s.KubeConfig;
	constructor(
		credentials: ICredentialDataDecryptedObject,
		private readonly func: IExecuteFunctions
	) {
		if (credentials === undefined) {
			throw new NodeOperationError(
				func.getNode(),
				"No credentials got returned!"
			);
		}
		const kubeConfig = new k8s.KubeConfig();
		switch (credentials.loadFrom) {
			case "automatic":
				kubeConfig.loadFromDefault();
				break;
			case "file":
				if (
					typeof credentials.filePath !== "string" ||
					credentials.filePath === ""
				) {
					throw new NodeOperationError(
						func.getNode(),
						"File path not set!"
					);
				}
				kubeConfig.loadFromFile(credentials.filePath);
				break;
			case "content":
				if (
					typeof credentials.content !== "string" ||
					credentials.content === ""
				) {
					throw new NodeOperationError(
						func.getNode(),
						"Content not set!"
					);
				}
				kubeConfig.loadFromString(credentials.content);
				break;
			default:
				throw new NodeOperationError(
					func.getNode(),
					"Load from value not set!"
				);
		}
		this.kubeConfig = kubeConfig;
	}
	async runPodAndGetOutput(
		image: string,
		args: string[],
		podName?: string,
		namespace = "default"
	): Promise<string> {
		const kc = this.kubeConfig;

		const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
		const watch = new k8s.Watch(kc);

		podName ??= `n8n-pod-${Date.now()}`;

		console.log(`[DEBUG] runPodAndGetOutput called with:`, {
			image,
			args,
			podName,
			namespace
		});

		const podSpec: k8s.V1Pod = {
			metadata: {
				name: podName,
				labels: {
					"managed-by-automation": "n8n"
				}
			},
			spec: {
				restartPolicy: "Never",
				containers: [
					{
						name: "main-container",
						image: image,
						args,
					},
				],
			},
		};

		console.log(`[DEBUG] Creating pod with spec:`, JSON.stringify(podSpec, null, 2));

		try {
			await k8sCoreApi.createNamespacedPod({
				namespace: namespace,
				body: podSpec
			});
			console.log(`[DEBUG] Pod created successfully: ${podName}`);
		} catch (error) {
			console.error(`[DEBUG] Failed to create pod ${podName}:`, error);
			throw new NodeOperationError(
				this.func.getNode(),
				`Failed to create pod "${podName}" in namespace "${namespace}": ${error.message}`
			);
		}

		try {
			const result = await new Promise<string>(async (resolve, reject) => {
				let podCompleted = false;

				const watchReq = await watch.watch(
					`/api/v1/namespaces/${namespace}/pods`,
					{},
					(type, obj: k8s.V1Pod) => {
						if (obj.metadata?.name !== podName) {
							return;
						}
						const phase = obj.status?.phase;
						console.log(`[DEBUG] Pod ${podName} phase update: ${phase}`);

												if (phase === "Succeeded" || phase === "Failed") {
							console.log(`[DEBUG] Pod ${podName} completed with phase: ${phase}`);
							podCompleted = true;

							// Use the unified log retrieval method
							this.retrievePodLogs(podName, namespace, "main-container", {
								tailLines: 1000
							}).then((logs) => {
								// Abort the watch after resolving to avoid race conditions
								setTimeout(() => {
									watchReq?.abort();
								}, 100);
								resolve(logs);
							}).catch((err) => {
								console.error(`[DEBUG] Log API error for pod ${podName}:`, err);
								setTimeout(() => {
									watchReq?.abort();
								}, 100);
								reject(err);
							});
						}
									},
				(err) => {
					// Don't treat AbortError as a real error if the pod has already completed
					if (this.isExpectedAbortError(err, podCompleted)) {
						console.log(`[DEBUG] Pod watch aborted for ${podName} after completion (expected)`);
						return;
					}
					console.error(`[DEBUG] Watch error for pod ${podName}:`, err);
					reject(err);
				}
				);
			});
			return result;
		} catch (e) {
			if (e.message === "aborted" || e.type === "aborted") {
				console.log(`[DEBUG] Watch aborted for pod ${podName}`);
				// This is fine
				return "";
			} else {
				console.error(`[DEBUG] Error running pod ${podName}:`, e);
				throw e;
			}
		} finally {
			console.log(`[DEBUG] Deleting pod ${podName}`);
			try {
				await k8sCoreApi.deleteNamespacedPod({
					name: podName,
					namespace: namespace
				});
				console.log(`[DEBUG] Pod ${podName} deleted successfully`);
			} catch (deleteError) {
				console.error(`[DEBUG] Failed to delete pod ${podName}:`, deleteError);
			}
		}
	}

	async runJobAndGetOutput(
		image: string,
		args: string[],
		jobName: string,
		namespace = "default",
		restartPolicy = "Never",
		cleanupJob = true
	): Promise<any> {
		const kc = this.kubeConfig;
		const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);

		console.log(`[DEBUG] runJobAndGetOutput called with:`, {
			image,
			args,
			jobName,
			namespace,
			restartPolicy,
			cleanupJob
		});

		// Validate input parameters
		if (!jobName || jobName.trim() === "") {
			console.error(`[DEBUG] Job name validation failed: empty or invalid name`);
			throw new NodeOperationError(
				this.func.getNode(),
				"Job name is required and cannot be empty"
			);
		}

		if (!image || image.trim() === "") {
			console.error(`[DEBUG] Image validation failed: empty or invalid image`);
			throw new NodeOperationError(
				this.func.getNode(),
				"Image is required and cannot be empty"
			);
		}

		// Validate Kubernetes naming convention
		const k8sNameRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
		if (!k8sNameRegex.test(jobName)) {
			console.error(`[DEBUG] Job name validation failed: invalid format for name "${jobName}"`);
			throw new NodeOperationError(
				this.func.getNode(),
				`Job name "${jobName}" is invalid. Must match pattern: [a-z0-9]([-a-z0-9]*[a-z0-9])?`
			);
		}

		// Add random suffix to avoid conflicts
		const randomSuffix = Math.random().toString(36).substring(2, 8);
		const finalJobName = `${jobName}-${randomSuffix}`;

		console.log(`[DEBUG] Generated final job name: ${finalJobName}`);

		// Ensure job name is not too long
		if (finalJobName.length > 63) {
			console.error(`[DEBUG] Job name validation failed: name too long (${finalJobName.length} > 63)`);
			throw new NodeOperationError(
				this.func.getNode(),
				`Job name "${finalJobName}" is too long. Maximum length is 63 characters`
			);
		}

		const jobSpec: k8s.V1Job = {
			metadata: {
				name: finalJobName,
				labels: {
					"managed-by-automation": "n8n"
				}
			},
			spec: {
				template: {
					metadata: {
						labels: {
							"managed-by-automation": "n8n"
						}
					},
					spec: {
						restartPolicy: restartPolicy as any,
						containers: [
							{
								name: "main-container",
								image: image,
								args,
							},
						],
					},
				},
			},
		};

		// Create the job
		try {
			console.log(`[DEBUG] Creating job with spec:`, JSON.stringify(jobSpec, null, 2));
			await k8sBatchApi.createNamespacedJob({
				namespace: namespace,
				body: jobSpec
			});
			console.log(`[DEBUG] Job created successfully: ${finalJobName}`);
		} catch (error) {
			console.error(`[DEBUG] Failed to create job ${finalJobName}:`, error);
			const errorDetails = error.response?.body || error;
			throw new NodeOperationError(
				this.func.getNode(),
				`Failed to create job "${finalJobName}" in namespace "${namespace}": ${error.message}. Details: ${JSON.stringify(errorDetails)}`
			);
		}

		try {
			// Wait for job completion
			const { status, jobStatus } = await this.waitForJobCompletion(finalJobName, namespace);

			// Get job output logs
			let output: string;
			try {
				output = await this.getJobPodLogs(finalJobName, namespace, "main-container");
			} catch (logError) {
				console.warn(`[DEBUG] Failed to get logs for job ${finalJobName}:`, logError);
				// If we can't get logs, use job status info
				output = status === "succeeded"
					? `Job completed successfully. ${jobStatus.succeeded} pod(s) succeeded.`
					: `Job failed. ${jobStatus.failed} pod(s) failed.`;
			}

			// Cleanup job if requested
			if (cleanupJob) {
				console.log(`[DEBUG] Cleaning up job ${finalJobName}`);
				try {
					await k8sBatchApi.deleteNamespacedJob({
						name: finalJobName,
						namespace: namespace
					});
					console.log(`[DEBUG] Job ${finalJobName} cleaned up successfully`);
				} catch (cleanupErr) {
					// Don't fail the whole operation if cleanup fails
					console.warn(`[DEBUG] Failed to cleanup job ${finalJobName}:`, cleanupErr);
				}
			}

			const result = {
				jobName: finalJobName,
				namespace: namespace,
				status: status === "succeeded" ? "completed" : "failed",
				jobStatus: status,
				output: this.formatOutput(output),
				cleaned: cleanupJob,
			};

			console.log(`[DEBUG] Job ${finalJobName} completed successfully with result:`, result);
			return result;
		} catch (e) {
			if (e.message === "aborted" || e.type === "aborted") {
				console.log(`[DEBUG] Job watch was aborted for ${finalJobName}`);
				// This is fine, job watching was aborted
				return {
					jobName: finalJobName,
					namespace: namespace,
					status: "unknown",
					jobStatus: "unknown",
					output: "Job watch was aborted",
					cleaned: false,
				};
			} else {
				console.error(`[DEBUG] Error running job ${finalJobName}:`, e);
				throw e;
			}
		}
	}

	async patchResource(
		apiVersion: string,
		kind: string,
		name: string,
		namespace: string,
		patchData: any
	): Promise<any> {
		const kc = this.kubeConfig;

		console.log(`[DEBUG] patchResource called with:`, {
			apiVersion,
			kind,
			name,
			namespace,
			patchData: JSON.stringify(patchData, null, 2)
		});

		// Create a custom objects API client
		const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);

		// Handle core resources
		if (apiVersion === 'v1') {
			const coreApi = kc.makeApiClient(k8s.CoreV1Api);
			console.log(`[DEBUG] Using CoreV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'pod':
					try {
						console.log(`[DEBUG] Patching pod ${name} in namespace ${namespace}`);
						const patchedPod = await coreApi.patchNamespacedPod({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] Pod patch successful:`, patchedPod);
						return patchedPod;
					} catch (error) {
						console.error(`[DEBUG] Pod patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch pod "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'service':
					try {
						console.log(`[DEBUG] Patching service ${name} in namespace ${namespace}`);
						const patchedService = await coreApi.patchNamespacedService({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] Service patch successful:`, patchedService);
						return patchedService;
					} catch (error) {
						console.error(`[DEBUG] Service patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch service "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'configmap':
					try {
						console.log(`[DEBUG] Patching configmap ${name} in namespace ${namespace}`);
						const patchedConfigMap = await coreApi.patchNamespacedConfigMap({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] ConfigMap patch successful:`, patchedConfigMap);
						return patchedConfigMap;
					} catch (error) {
						console.error(`[DEBUG] ConfigMap patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch configmap "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported core resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'apps/v1') {
			const appsApi = kc.makeApiClient(k8s.AppsV1Api);
			console.log(`[DEBUG] Using AppsV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'deployment':
					try {
						console.log(`[DEBUG] Patching deployment ${name} in namespace ${namespace}`);
						console.log(`[DEBUG] Patch data:`, JSON.stringify(patchData, null, 2));

						const patchedDeployment = await appsApi.patchNamespacedDeployment({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] Deployment patch successful:`, patchedDeployment);
						return patchedDeployment;
					} catch (error) {
						console.error(`[DEBUG] Deployment patch failed:`, {
							name,
							namespace,
							error: error.message,
							response: error.response?.body,
							status: error.response?.statusCode
						});
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch deployment "${name}" in namespace "${namespace}": ${error.message}. Status: ${error.response?.statusCode}. Details: ${JSON.stringify(error.response?.body || {})}`
						);
					}
				case 'replicaset':
					try {
						console.log(`[DEBUG] Patching replicaset ${name} in namespace ${namespace}`);
						const patchedReplicaSet = await appsApi.patchNamespacedReplicaSet({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] ReplicaSet patch successful:`, patchedReplicaSet);
						return patchedReplicaSet;
					} catch (error) {
						console.error(`[DEBUG] ReplicaSet patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch replicaset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'daemonset':
					try {
						console.log(`[DEBUG] Patching daemonset ${name} in namespace ${namespace}`);
						const patchedDaemonSet = await appsApi.patchNamespacedDaemonSet({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] DaemonSet patch successful:`, patchedDaemonSet);
						return patchedDaemonSet;
					} catch (error) {
						console.error(`[DEBUG] DaemonSet patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch daemonset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'statefulset':
					try {
						console.log(`[DEBUG] Patching statefulset ${name} in namespace ${namespace}`);
						const patchedStatefulSet = await appsApi.patchNamespacedStatefulSet({
							name: name,
							namespace: namespace,
							body: patchData
						});
						console.log(`[DEBUG] StatefulSet patch successful:`, patchedStatefulSet);
						return patchedStatefulSet;
					} catch (error) {
						console.error(`[DEBUG] StatefulSet patch failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to patch statefulset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported apps resource type: ${kind}`
					);
			}
		} else {
			// Handle custom resources
			try {
				console.log(`[DEBUG] Using CustomObjectsApi for ${apiVersion}/${kind}`);
				const [group, version] = apiVersion.split('/');
				const response = await customObjectsApi.patchNamespacedCustomObject({
					group: group,
					version: version,
					namespace: namespace,
					plural: kind.toLowerCase() + 's', // Pluralize the kind
					name: name,
					body: patchData
				});
				console.log(`[DEBUG] Custom resource patch successful:`, response.body);
				return response.body;
			} catch (error) {
				console.error(`[DEBUG] Custom resource patch failed:`, error);
				throw new NodeOperationError(
					this.func.getNode(),
					`Failed to patch custom resource "${name}" in namespace "${namespace}": ${error.message}`
				);
			}
		}
	}

	async getResource(
		apiVersion: string,
		kind: string,
		name: string,
		namespace: string
	): Promise<any> {
		const kc = this.kubeConfig;

		console.log(`[DEBUG] getResource called with:`, {
			apiVersion,
			kind,
			name,
			namespace
		});

		// Handle core resources
		if (apiVersion === 'v1') {
			const coreApi = kc.makeApiClient(k8s.CoreV1Api);
			console.log(`[DEBUG] Using CoreV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'pod':
					try {
						console.log(`[DEBUG] Getting pod ${name} in namespace ${namespace}`);
						const pod = await coreApi.readNamespacedPod({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] Pod retrieved successfully`);
						return pod;
					} catch (error) {
						console.error(`[DEBUG] Pod retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get pod "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'service':
					try {
						console.log(`[DEBUG] Getting service ${name} in namespace ${namespace}`);
						const service = await coreApi.readNamespacedService({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] Service retrieved successfully`);
						return service;
					} catch (error) {
						console.error(`[DEBUG] Service retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get service "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'configmap':
					try {
						console.log(`[DEBUG] Getting configmap ${name} in namespace ${namespace}`);
						const configMap = await coreApi.readNamespacedConfigMap({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] ConfigMap retrieved successfully`);
						return configMap;
					} catch (error) {
						console.error(`[DEBUG] ConfigMap retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get configmap "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'secret':
					try {
						console.log(`[DEBUG] Getting secret ${name} in namespace ${namespace}`);
						const secret = await coreApi.readNamespacedSecret({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] Secret retrieved successfully`);
						return secret;
					} catch (error) {
						console.error(`[DEBUG] Secret retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get secret "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported core resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'apps/v1') {
			const appsApi = kc.makeApiClient(k8s.AppsV1Api);
			console.log(`[DEBUG] Using AppsV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'deployment':
					try {
						console.log(`[DEBUG] Getting deployment ${name} in namespace ${namespace}`);
						const deployment = await appsApi.readNamespacedDeployment({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] Deployment retrieved successfully`);
						return deployment;
					} catch (error) {
						console.error(`[DEBUG] Deployment retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get deployment "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'replicaset':
					try {
						console.log(`[DEBUG] Getting replicaset ${name} in namespace ${namespace}`);
						const replicaSet = await appsApi.readNamespacedReplicaSet({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] ReplicaSet retrieved successfully`);
						return replicaSet;
					} catch (error) {
						console.error(`[DEBUG] ReplicaSet retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get replicaset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'daemonset':
					try {
						console.log(`[DEBUG] Getting daemonset ${name} in namespace ${namespace}`);
						const daemonSet = await appsApi.readNamespacedDaemonSet({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] DaemonSet retrieved successfully`);
						return daemonSet;
					} catch (error) {
						console.error(`[DEBUG] DaemonSet retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get daemonset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'statefulset':
					try {
						console.log(`[DEBUG] Getting statefulset ${name} in namespace ${namespace}`);
						const statefulSet = await appsApi.readNamespacedStatefulSet({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] StatefulSet retrieved successfully`);
						return statefulSet;
					} catch (error) {
						console.error(`[DEBUG] StatefulSet retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get statefulset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported apps resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'batch/v1') {
			const batchApi = kc.makeApiClient(k8s.BatchV1Api);
			console.log(`[DEBUG] Using BatchV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'job':
					try {
						console.log(`[DEBUG] Getting job ${name} in namespace ${namespace}`);
						const job = await batchApi.readNamespacedJob({
							name: name,
							namespace: namespace
						});
						console.log(`[DEBUG] Job retrieved successfully`);
						return job;
					} catch (error) {
						console.error(`[DEBUG] Job retrieval failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to get job "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported batch resource type: ${kind}`
					);
			}
		} else {
			// Handle custom resources
			try {
				console.log(`[DEBUG] Using CustomObjectsApi for ${apiVersion}/${kind}`);
				const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
				const [group, version] = apiVersion.split('/');
				console.log(`[DEBUG] Getting custom resource ${name} in namespace ${namespace} (group: ${group}, version: ${version})`);

				const response = await customObjectsApi.getNamespacedCustomObject({
					group: group,
					version: version,
					namespace: namespace,
					plural: kind.toLowerCase() + 's', // Pluralize the kind
					name: name
				});
				console.log(`[DEBUG] Custom resource retrieved successfully`);
				return response.body;
			} catch (error) {
				console.error(`[DEBUG] Custom resource retrieval failed:`, error);
				throw new NodeOperationError(
					this.func.getNode(),
					`Failed to get custom resource "${name}" in namespace "${namespace}": ${error.message}`
				);
			}
		}
	}

	async listResources(
		apiVersion: string,
		kind: string,
		namespace: string
	): Promise<any> {
		const kc = this.kubeConfig;

		console.log(`[DEBUG] listResources called with:`, {
			apiVersion,
			kind,
			namespace
		});

		// Handle core resources
		if (apiVersion === 'v1') {
			const coreApi = kc.makeApiClient(k8s.CoreV1Api);
			console.log(`[DEBUG] Using CoreV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'pod':
					try {
						console.log(`[DEBUG] Listing pods in namespace ${namespace}`);
						const pods = await coreApi.listNamespacedPod({
							namespace: namespace
						});
						console.log(`[DEBUG] Pods listed successfully, found ${pods.items?.length || 0} pods`);
						return pods;
					} catch (error) {
						console.error(`[DEBUG] Pod listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list pods in namespace "${namespace}": ${error.message}`
						);
					}
				case 'service':
					try {
						console.log(`[DEBUG] Listing services in namespace ${namespace}`);
						const services = await coreApi.listNamespacedService({
							namespace: namespace
						});
						console.log(`[DEBUG] Services listed successfully, found ${services.items?.length || 0} services`);
						return services;
					} catch (error) {
						console.error(`[DEBUG] Service listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list services in namespace "${namespace}": ${error.message}`
						);
					}
				case 'configmap':
					try {
						console.log(`[DEBUG] Listing configmaps in namespace ${namespace}`);
						const configMaps = await coreApi.listNamespacedConfigMap({
							namespace: namespace
						});
						console.log(`[DEBUG] ConfigMaps listed successfully, found ${configMaps.items?.length || 0} configmaps`);
						return configMaps;
					} catch (error) {
						console.error(`[DEBUG] ConfigMap listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list configmaps in namespace "${namespace}": ${error.message}`
						);
					}
				case 'secret':
					try {
						console.log(`[DEBUG] Listing secrets in namespace ${namespace}`);
						const secrets = await coreApi.listNamespacedSecret({
							namespace: namespace
						});
						console.log(`[DEBUG] Secrets listed successfully, found ${secrets.items?.length || 0} secrets`);
						return secrets;
					} catch (error) {
						console.error(`[DEBUG] Secret listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list secrets in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported core resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'apps/v1') {
			const appsApi = kc.makeApiClient(k8s.AppsV1Api);
			console.log(`[DEBUG] Using AppsV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'deployment':
					try {
						console.log(`[DEBUG] Listing deployments in namespace ${namespace}`);
						const deployments = await appsApi.listNamespacedDeployment({
							namespace: namespace
						});
						console.log(`[DEBUG] Deployments listed successfully, found ${deployments.items?.length || 0} deployments`);
						return deployments;
					} catch (error) {
						console.error(`[DEBUG] Deployment listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list deployments in namespace "${namespace}": ${error.message}`
						);
					}
				case 'replicaset':
					try {
						console.log(`[DEBUG] Listing replicasets in namespace ${namespace}`);
						const replicaSets = await appsApi.listNamespacedReplicaSet({
							namespace: namespace
						});
						console.log(`[DEBUG] ReplicaSets listed successfully, found ${replicaSets.items?.length || 0} replicasets`);
						return replicaSets;
					} catch (error) {
						console.error(`[DEBUG] ReplicaSet listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list replicasets in namespace "${namespace}": ${error.message}`
						);
					}
				case 'daemonset':
					try {
						console.log(`[DEBUG] Listing daemonsets in namespace ${namespace}`);
						const daemonSets = await appsApi.listNamespacedDaemonSet({
							namespace: namespace
						});
						console.log(`[DEBUG] DaemonSets listed successfully, found ${daemonSets.items?.length || 0} daemonsets`);
						return daemonSets;
					} catch (error) {
						console.error(`[DEBUG] DaemonSet listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list daemonsets in namespace "${namespace}": ${error.message}`
						);
					}
				case 'statefulset':
					try {
						console.log(`[DEBUG] Listing statefulsets in namespace ${namespace}`);
						const statefulSets = await appsApi.listNamespacedStatefulSet({
							namespace: namespace
						});
						console.log(`[DEBUG] StatefulSets listed successfully, found ${statefulSets.items?.length || 0} statefulsets`);
						return statefulSets;
					} catch (error) {
						console.error(`[DEBUG] StatefulSet listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list statefulsets in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported apps resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'batch/v1') {
			const batchApi = kc.makeApiClient(k8s.BatchV1Api);
			console.log(`[DEBUG] Using BatchV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'job':
					try {
						console.log(`[DEBUG] Listing jobs in namespace ${namespace}`);
						const jobs = await batchApi.listNamespacedJob({
							namespace: namespace
						});
						console.log(`[DEBUG] Jobs listed successfully, found ${jobs.items?.length || 0} jobs`);
						return jobs;
					} catch (error) {
						console.error(`[DEBUG] Job listing failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to list jobs in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported batch resource type: ${kind}`
					);
			}
		} else {
			// Handle custom resources
			try {
				console.log(`[DEBUG] Using CustomObjectsApi for ${apiVersion}/${kind}`);
				const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
				const [group, version] = apiVersion.split('/');
				console.log(`[DEBUG] Listing custom resources in namespace ${namespace} (group: ${group}, version: ${version})`);

				const response = await customObjectsApi.listNamespacedCustomObject({
					group: group,
					version: version,
					namespace: namespace,
					plural: kind.toLowerCase() + 's' // Pluralize the kind
				});
				console.log(`[DEBUG] Custom resources listed successfully, found ${(response.body as any).items?.length || 0} resources`);
				return response.body;
			} catch (error) {
				console.error(`[DEBUG] Custom resource listing failed:`, error);
				throw new NodeOperationError(
					this.func.getNode(),
					`Failed to list custom resources in namespace "${namespace}": ${error.message}`
				);
			}
		}
	}

	async waitForResource(
		apiVersion: string,
		kind: string,
		name: string,
		namespace: string,
		condition: string,
		timeout = 300000 // 5 minutes default timeout
	): Promise<any> {
		const kc = this.kubeConfig;
		const watch = new k8s.Watch(kc);

		console.log(`[DEBUG] Starting wait for ${kind}/${name} condition: ${condition}`);

		return new Promise(async (resolve, reject) => {
			let timeoutId: NodeJS.Timeout;
			let watchReq: any;
			let resourceCompleted = false;

			const clearTimeoutIfNeeded = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
			};

			// Set timeout
			timeoutId = setTimeout(() => {
				if (!resourceCompleted) {
					console.log(`[DEBUG] Timeout reached for ${kind}/${name}, aborting watch`);
					if (watchReq) {
						watchReq.abort();
					}
					reject(new Error(`Timeout waiting for ${kind}/${name} condition: ${condition}`));
				}
			}, timeout);

			try {
				// Construct the watch path based on resource type
				let watchPath: string;
				if (apiVersion === 'v1') {
					switch (kind.toLowerCase()) {
						case 'pod':
							watchPath = `/api/v1/namespaces/${namespace}/pods`;
							break;
						case 'service':
							watchPath = `/api/v1/namespaces/${namespace}/services`;
							break;
						case 'configmap':
							watchPath = `/api/v1/namespaces/${namespace}/configmaps`;
							break;
						case 'secret':
							watchPath = `/api/v1/namespaces/${namespace}/secrets`;
							break;
						default:
							throw new Error(`Unsupported core resource type: ${kind}`);
					}
				} else if (apiVersion === 'apps/v1') {
					switch (kind.toLowerCase()) {
						case 'deployment':
							watchPath = `/apis/apps/v1/namespaces/${namespace}/deployments`;
							break;
						case 'replicaset':
							watchPath = `/apis/apps/v1/namespaces/${namespace}/replicasets`;
							break;
						case 'daemonset':
							watchPath = `/apis/apps/v1/namespaces/${namespace}/daemonsets`;
							break;
						case 'statefulset':
							watchPath = `/apis/apps/v1/namespaces/${namespace}/statefulsets`;
							break;
						default:
							throw new Error(`Unsupported apps resource type: ${kind}`);
					}
				} else if (apiVersion === 'batch/v1') {
					switch (kind.toLowerCase()) {
						case 'job':
							watchPath = `/apis/batch/v1/namespaces/${namespace}/jobs`;
							break;
						default:
							throw new Error(`Unsupported batch resource type: ${kind}`);
					}
				} else {
					const [group, version] = apiVersion.split('/');
					watchPath = `/apis/${group}/${version}/namespaces/${namespace}/${kind.toLowerCase()}s`;
				}

				watchReq = await watch.watch(
					watchPath,
					{},
					(type, obj: any) => {
						if (obj.metadata?.name !== name) {
							return;
						}

						console.log(`[DEBUG] Resource ${kind}/${name} update:`, {
							type,
							status: obj.status,
							conditions: obj.status?.conditions
						});

						// Check condition based on resource type and condition
						let conditionMet = false;

						if (condition === 'Ready' && kind.toLowerCase() === 'pod') {
							const podConditions = obj.status?.conditions || [];
							const readyCondition = podConditions.find((c: any) => c.type === 'Ready');
							conditionMet = readyCondition?.status === 'True';
						} else if (condition === 'Available' && kind.toLowerCase() === 'deployment') {
							const deploymentConditions = obj.status?.conditions || [];
							const availableCondition = deploymentConditions.find((c: any) => c.type === 'Available');
							conditionMet = availableCondition?.status === 'True';
						} else if (condition === 'Complete' && kind.toLowerCase() === 'job') {
							const jobConditions = obj.status?.conditions || [];
							const completeCondition = jobConditions.find((c: any) => c.type === 'Complete');
							conditionMet = completeCondition?.status === 'True';
						} else if (condition === 'Failed' && kind.toLowerCase() === 'job') {
							const jobConditions = obj.status?.conditions || [];
							const failedCondition = jobConditions.find((c: any) => c.type === 'Failed');
							conditionMet = failedCondition?.status === 'True';
						} else if (condition === 'Succeeded' && kind.toLowerCase() === 'pod') {
							conditionMet = obj.status?.phase === 'Succeeded';
						} else if (condition === 'Failed' && kind.toLowerCase() === 'pod') {
							conditionMet = obj.status?.phase === 'Failed';
						} else if (kind.toLowerCase() === 'statefulset') {
							// StatefulSet doesn't have conditions, check based on replica status
							const replicas = obj.spec?.replicas || 0;
							const readyReplicas = obj.status?.readyReplicas || 0;
							const currentReplicas = obj.status?.currentReplicas || 0;
							const updatedReplicas = obj.status?.updatedReplicas || 0;

							console.log(`[DEBUG] StatefulSet ${obj.metadata?.name} status:`, {
								replicas,
								readyReplicas,
								currentReplicas,
								updatedReplicas,
								condition
							});

							if (condition === 'Ready' || condition === 'Available') {
								// Ready when all replicas are ready
								conditionMet = replicas > 0 && readyReplicas === replicas;
							} else if (condition === 'Complete') {
								// Complete when all replicas are current and updated
								conditionMet = replicas > 0 && currentReplicas === replicas && updatedReplicas === replicas;
							} else if (condition === 'Succeeded') {
								// Succeeded when all replicas are ready and updated
								conditionMet = replicas > 0 && readyReplicas === replicas && updatedReplicas === replicas;
							} else {
								// Default: consider ready when all replicas are ready
								conditionMet = replicas > 0 && readyReplicas === replicas;
							}
						} else {
							// Generic condition check
							const conditions = obj.status?.conditions || [];
							const matchingCondition = conditions.find((c: any) => c.type === condition);
							conditionMet = matchingCondition?.status === 'True';
						}

						if (conditionMet) {
							resourceCompleted = true;
							clearTimeoutIfNeeded();

							console.log(`[DEBUG] Resource ${kind}/${name} condition ${condition} met`);

							// Abort the watch after resolving to avoid race conditions
							setTimeout(() => {
								if (watchReq) {
									watchReq.abort();
								}
							}, 100);

							resolve({
								resource: obj,
								condition: condition,
								status: 'met'
							});
						}
									},
				(err) => {
					// Don't treat AbortError as a real error if the resource has already completed
					if (this.isExpectedAbortError(err, resourceCompleted)) {
						console.log(`[DEBUG] Resource watch aborted for ${kind}/${name} after condition met (expected)`);
						return;
					}
					console.error(`[DEBUG] Resource watch error for ${kind}/${name}:`, err);
					clearTimeoutIfNeeded();
					reject(err);
				}
				);
			} catch (error) {
				clearTimeoutIfNeeded();
				reject(error);
			}
		});
	}

	async getLogs(
		podName: string,
		namespace: string,
		containerName?: string,
		follow = false,
		tail?: number,
		sinceTime?: string
	): Promise<string> {
		console.log(`[DEBUG] getLogs called with:`, {
			podName,
			namespace,
			containerName,
			follow,
			tail,
			sinceTime
		});

		// If no container name is provided, get the first container from the pod
		if (!containerName) {
			try {
				const k8sCoreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
				const podResponse = await k8sCoreApi.readNamespacedPod({
					name: podName,
					namespace: namespace
				});

				if (podResponse.spec?.containers && podResponse.spec.containers.length > 0) {
					containerName = podResponse.spec.containers[0].name;
					console.log(`[DEBUG] Using first container: ${containerName}`);
				} else {
					throw new NodeOperationError(
						this.func.getNode(),
						`Pod "${podName}" has no containers`
					);
				}
			} catch (error) {
				console.error(`[DEBUG] Failed to get pod details for ${podName}:`, error);
				throw new NodeOperationError(
					this.func.getNode(),
					`Failed to get pod details for "${podName}": ${error.message}`
				);
			}
		}

		// Use the unified log retrieval method
		return this.retrievePodLogs(podName, namespace, containerName, {
			follow,
			tailLines: tail,
			sinceTime
		});
	}

	async getLogsByLabelSelector(
		labelSelector: string,
		namespace: string,
		containerName?: string,
		follow = false,
		tail?: number,
		sinceTime?: string
	): Promise<any> {
		console.log(`[DEBUG] getLogsByLabelSelector called with:`, {
			labelSelector,
			namespace,
			containerName,
			follow,
			tail,
			sinceTime
		});

		const k8sCoreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);

		// First, find all pods that match the label selector
		let podsResponse;
		try {
			console.log(`[DEBUG] Searching for pods with label selector: ${labelSelector}`);
			podsResponse = await k8sCoreApi.listNamespacedPod({
				namespace: namespace,
				labelSelector: labelSelector
			});
		} catch (error) {
			console.error(`[DEBUG] Failed to list pods with label selector ${labelSelector}:`, error);
			throw new NodeOperationError(
				this.func.getNode(),
				`Failed to list pods with label selector "${labelSelector}" in namespace "${namespace}": ${error.message}`
			);
		}

		console.log(`[DEBUG] Found ${podsResponse.items?.length || 0} pods matching label selector`);

		if (!podsResponse.items || podsResponse.items.length === 0) {
			console.log(`[DEBUG] No pods found matching label selector ${labelSelector}`);
			return {
				podsFound: 0,
				pods: [],
				totalLogs: "No pods found matching the label selector"
			};
		}

		// Get logs from all matching pods
		const podLogs: any[] = [];
		let allLogs = "";

		for (const pod of podsResponse.items) {
			const podName = pod.metadata?.name;
			if (!podName) {
				console.warn(`[DEBUG] Pod found without name, skipping`);
				continue;
			}

			console.log(`[DEBUG] Getting logs for pod: ${podName}`);

			try {
				// Determine container name if not provided
				let targetContainerName = containerName;
				if (!targetContainerName) {
					if (pod.spec?.containers && pod.spec.containers.length > 0) {
						targetContainerName = pod.spec.containers[0].name;
						console.log(`[DEBUG] Using first container for pod ${podName}: ${targetContainerName}`);
					} else {
						console.warn(`[DEBUG] Pod ${podName} has no containers, skipping`);
						continue;
					}
				}

				// Get logs for this pod
				const logs = await this.retrievePodLogs(podName, namespace, targetContainerName, {
					follow,
					tailLines: tail,
					sinceTime
				});

				const podLogEntry = {
					podName: podName,
					container: targetContainerName,
					logs: logs,
					phase: pod.status?.phase || "Unknown"
				};

				podLogs.push(podLogEntry);

				// Concatenate all logs with pod identification
				allLogs += `\n=== Pod: ${podName} (${targetContainerName}) ===\n`;
				allLogs += logs;
				allLogs += `\n=== End of ${podName} logs ===\n`;

			} catch (error) {
				console.error(`[DEBUG] Failed to get logs for pod ${podName}:`, error);
				const podLogEntry = {
					podName: podName,
					container: containerName || "unknown",
					logs: `Error getting logs: ${error.message}`,
					phase: pod.status?.phase || "Unknown",
					error: error.message
				};
				podLogs.push(podLogEntry);

				// Include error in combined logs
				allLogs += `\n=== Pod: ${podName} (Error) ===\n`;
				allLogs += `Error getting logs: ${error.message}\n`;
				allLogs += `=== End of ${podName} logs ===\n`;
			}
		}

		const result = {
			podsFound: podsResponse.items.length,
			pods: podLogs,
			totalLogs: allLogs.trim(),
			labelSelector: labelSelector,
			namespace: namespace
		};

		console.log(`[DEBUG] Retrieved logs from ${podLogs.length} pods`);
		return result;
	}

	// Helper method to format output - try JSON parse first, fallback to raw string
	private formatOutput(output: any): any {
		// Handle non-string inputs
		if (typeof output !== 'string') {
			console.log(`[DEBUG] Output is not a string (type: ${typeof output}), returning as-is`);
			return output;
		}

		if (!output || output.trim() === "") {
			return output;
		}

		try {
			// Try to parse as JSON
			const parsed = JSON.parse(output);
			console.log(`[DEBUG] Output successfully parsed as JSON`);
			return parsed;
		} catch (e) {
			// If JSON parsing fails, return the raw string
			console.log(`[DEBUG] Output is not valid JSON, returning raw string`);
			return output;
		}
	}

	// Helper to create safe promise handlers that prevent multiple resolve/reject
	private createSafePromiseHandlers(resolve: Function, reject: Function): SafePromiseHandlers {
		let resolved = false;

		return {
			safeResolve: (value: any) => {
				if (!resolved) {
					resolved = true;
					resolve(value);
				}
			},
			safeReject: (err: any) => {
				if (!resolved) {
					resolved = true;
					reject(err);
				}
			}
		};
	}

	// Helper to check if error is an expected abort error
	private isExpectedAbortError(err: any, completed: boolean): boolean {
		return (err.message === "aborted" || err.type === "aborted") && completed;
	}

	// Helper to validate time format
	private validateTimeFormat(timeString: string): void {
		const parsedTime = new Date(timeString);
		if (isNaN(parsedTime.getTime())) {
			throw new NodeOperationError(
				this.func.getNode(),
				`Invalid time format: ${timeString}. Please use RFC3339 format (e.g., 2024-01-01T00:00:00Z)`
			);
		}
	}

	// Unified log retrieval method
	private async retrievePodLogs(
		podName: string,
		namespace: string,
		containerName: string,
		options: LogOptions = {}
	): Promise<string> {
		const kc = this.kubeConfig;
		const logApi = new k8s.Log(kc);

		console.log(`[DEBUG] Starting log retrieval for pod ${podName}, container: ${containerName}`);

		return new Promise((resolve, reject) => {
			let logs = "";
			const { safeResolve, safeReject } = this.createSafePromiseHandlers(resolve, reject);

			const logStream = new PassThrough();
			logStream.on('data', (chunk) => {
				logs += chunk.toString();
			});

			logStream.on('end', () => {
				console.log(`[DEBUG] Log stream ended for pod ${podName}. Logs length: ${logs.length}`);
				safeResolve(this.formatOutput(logs));
			});

			logStream.on('error', (err) => {
				console.error(`[DEBUG] Log stream error for pod ${podName}:`, err);
				safeReject(new NodeOperationError(
					this.func.getNode(),
					`Failed to get logs for pod "${podName}": ${err.message}`
				));
			});

			// Build log options
			const logOptions: any = {
				pretty: false,
				timestamps: false,
				tailLines: options.tailLines || 1000
			};

			if (options.follow) {
				logOptions.follow = options.follow;
			}
			if (options.sinceTime) {
				try {
					this.validateTimeFormat(options.sinceTime);
					logOptions.sinceTime = options.sinceTime;
				} catch (error) {
					console.error(`[DEBUG] Invalid sinceTime format: ${options.sinceTime}`, error);
					safeReject(error);
					return;
				}
			}

			console.log(`[DEBUG] Log options:`, logOptions);

			// Use the correct API call format
			logApi.log(
				namespace,
				podName,
				containerName,
				logStream,
				logOptions
			).then((req: any) => {
				console.log(`[DEBUG] Log request started for pod ${podName}`);

				// Set timeout based on follow mode
				const timeoutMs = options.follow ? 30000 : 10000;
				setTimeout(() => {
					console.log(`[DEBUG] Log timeout reached for pod ${podName}, ending stream`);
					if (options.follow && req && req.abort) {
						req.abort();
					}
					logStream.end();
					safeResolve(this.formatOutput(logs));
				}, timeoutMs);
			}).catch((err) => {
				console.error(`[DEBUG] Log API error for pod ${podName}:`, err);
				safeReject(new NodeOperationError(
					this.func.getNode(),
					`Failed to get logs for pod "${podName}" in namespace "${namespace}": ${err.message}`
				));
			});
		});
	}

	async triggerCronJob(
		cronJobName: string,
		namespace = "default",
		cleanupJob = true,
		overrides?: {
			command?: string[];
			args?: string[];
			envs?: { name: string; value: string }[];
		}
	): Promise<any> {
		const kc = this.kubeConfig;
		const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);

		console.log(`[DEBUG] triggerCronJob called with:`, {
			cronJobName,
			namespace,
			cleanupJob,
			overrides
		});

						// First, get the CronJob to extract its jobTemplate
		let cronJob: k8s.V1CronJob;
		try {
			console.log(`[DEBUG] Getting CronJob ${cronJobName} from namespace ${namespace}`);

			// Use BatchV1Api for CronJob (available since Kubernetes 1.21)
			cronJob = await k8sBatchApi.readNamespacedCronJob({
				name: cronJobName,
				namespace: namespace
			});
			console.log(`[DEBUG] CronJob retrieved successfully from BatchV1Api`);
		} catch (error) {
			console.error(`[DEBUG] Failed to get CronJob ${cronJobName}:`, error);
			throw new NodeOperationError(
				this.func.getNode(),
				`Failed to get CronJob "${cronJobName}" in namespace "${namespace}": ${error.message}`
			);
		}

		// Ensure the CronJob has a valid jobTemplate
		if (!cronJob.spec?.jobTemplate?.spec) {
			throw new NodeOperationError(
				this.func.getNode(),
				`CronJob "${cronJobName}" does not have a valid jobTemplate`
			);
		}

		// Generate job name with timestamp (always add timestamp)
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const finalJobName = `${cronJobName}-${timestamp}`;

		console.log(`[DEBUG] Generated job name: ${finalJobName}`);

		// Validate job name
		const k8sNameRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
		if (!k8sNameRegex.test(finalJobName)) {
			console.error(`[DEBUG] Job name validation failed: invalid format for name "${finalJobName}"`);
			throw new NodeOperationError(
				this.func.getNode(),
				`Job name "${finalJobName}" is invalid. Must match pattern: [a-z0-9]([-a-z0-9]*[a-z0-9])?`
			);
		}

		// Ensure job name is not too long
		if (finalJobName.length > 63) {
			console.error(`[DEBUG] Job name validation failed: name too long (${finalJobName.length} > 63)`);
			throw new NodeOperationError(
				this.func.getNode(),
				`Job name "${finalJobName}" is too long. Maximum length is 63 characters`
			);
		}

		// Deep clone the job template to avoid modifying the original
		const jobTemplate = JSON.parse(JSON.stringify(cronJob.spec.jobTemplate));

		// Apply overrides if provided
		if (overrides && jobTemplate.spec?.template?.spec?.containers) {
			console.log(`[DEBUG] Applying overrides to job template`);

			// Apply overrides to all containers (or just the first one if you prefer)
			jobTemplate.spec.template.spec.containers.forEach((container: any, index: number) => {
				console.log(`[DEBUG] Processing container ${index}: ${container.name}`);

				// Override command
				if (overrides.command && overrides.command.length > 0) {
					console.log(`[DEBUG] Overriding command for container ${container.name}:`, overrides.command);
					container.command = overrides.command;
				}

				// Override args
				if (overrides.args && overrides.args.length > 0) {
					console.log(`[DEBUG] Overriding args for container ${container.name}:`, overrides.args);
					container.args = overrides.args;
				}

				// Override environment variables
				if (overrides.envs && overrides.envs.length > 0) {
					console.log(`[DEBUG] Overriding envs for container ${container.name}:`, overrides.envs);

					// Merge with existing environment variables
					const existingEnvs = container.env || [];
					const existingEnvNames = existingEnvs.map((env: any) => env.name);

					// Create a map of new environment variables
					const newEnvs = overrides.envs.filter(env => env.name && env.value !== undefined);

					// Add new environment variables or override existing ones
					newEnvs.forEach(newEnv => {
						const existingIndex = existingEnvNames.indexOf(newEnv.name);
						if (existingIndex >= 0) {
							// Override existing environment variable
							existingEnvs[existingIndex] = newEnv;
							console.log(`[DEBUG] Overriding existing env var: ${newEnv.name} = ${newEnv.value}`);
						} else {
							// Add new environment variable
							existingEnvs.push(newEnv);
							console.log(`[DEBUG] Adding new env var: ${newEnv.name} = ${newEnv.value}`);
						}
					});

					container.env = existingEnvs;
				}
			});
		}

		// Create job spec from CronJob template with overrides applied
		const jobSpec: k8s.V1Job = {
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: {
				name: finalJobName,
				namespace: namespace,
				labels: {
					...jobTemplate.metadata?.labels,
					"cronjob": cronJobName,
					"manual-trigger": "true",
					"managed-by-automation": "n8n"
				},
				annotations: {
					...jobTemplate.metadata?.annotations,
					"cronjob.kubernetes.io/created-from": cronJobName,
					"n8n.io/triggered-at": new Date().toISOString(),
					...(overrides ? { "n8n.io/overrides-applied": "true" } : {})
				}
			},
			spec: {
				...jobTemplate.spec,
				// Ensure template is provided
				template: {
					...jobTemplate.spec.template,
					metadata: {
						...jobTemplate.spec.template.metadata,
						labels: {
							...(jobTemplate.spec.template.metadata?.labels || {}),
							"managed-by-automation": "n8n"
						}
					}
				}
			}
		};

		console.log(`[DEBUG] Creating job from CronJob template with overrides:`, JSON.stringify(jobSpec, null, 2));

		// Create the job
		try {
			await k8sBatchApi.createNamespacedJob({
				namespace: namespace,
				body: jobSpec
			});
			console.log(`[DEBUG] Job created successfully: ${finalJobName}`);
		} catch (error) {
			console.error(`[DEBUG] Failed to create job ${finalJobName} from CronJob ${cronJobName}:`, error);
			const errorDetails = error.response?.body || error;
			throw new NodeOperationError(
				this.func.getNode(),
				`Failed to create job "${finalJobName}" from CronJob "${cronJobName}" in namespace "${namespace}": ${error.message}. Details: ${JSON.stringify(errorDetails)}`
			);
		}

		try {
			// Wait for job completion
			const { status, jobStatus } = await this.waitForJobCompletion(finalJobName, namespace);

			// Get job output logs
			let output: string;
			try {
				output = await this.getJobPodLogs(finalJobName, namespace);
			} catch (logError) {
				console.warn(`[DEBUG] Failed to get logs for job ${finalJobName}:`, logError);
				// If we can't get logs, use job status info
				output = status === "succeeded"
					? `Job completed successfully. ${jobStatus.succeeded} pod(s) succeeded.`
					: `Job failed. ${jobStatus.failed} pod(s) failed.`;
			}

			// Cleanup job if requested
			if (cleanupJob) {
				console.log(`[DEBUG] Cleaning up job ${finalJobName}`);
				try {
					await k8sBatchApi.deleteNamespacedJob({
						name: finalJobName,
						namespace: namespace
					});
					console.log(`[DEBUG] Job ${finalJobName} cleaned up successfully`);
				} catch (cleanupErr) {
					// Don't fail the whole operation if cleanup fails
					console.warn(`[DEBUG] Failed to cleanup job ${finalJobName}:`, cleanupErr);
				}
			}

			const result = {
				jobName: finalJobName,
				namespace: namespace,
				cronJobName: cronJobName,
				status: status === "succeeded" ? "completed" : "failed",
				jobStatus: status,
				createdAt: new Date().toISOString(),
				output: this.formatOutput(output),
				cleaned: cleanupJob,
				overridesApplied: !!overrides
			};

			console.log(`[DEBUG] CronJob ${cronJobName} triggered successfully with result:`, result);
			return result;
		} catch (e) {
			if (e.message === "aborted" || e.type === "aborted") {
				console.log(`[DEBUG] Job watch was aborted for ${finalJobName}`);
				// This is fine, job watching was aborted
				return {
					jobName: finalJobName,
					namespace: namespace,
					cronJobName: cronJobName,
					status: "unknown",
					jobStatus: "unknown",
					output: "Job watch was aborted",
					cleaned: false,
					overridesApplied: !!overrides
				};
			} else {
				console.error(`[DEBUG] Error running job ${finalJobName}:`, e);
				throw e;
			}
		}
	}

	// Helper method to wait for job completion
	private async waitForJobCompletion(
		jobName: string,
		namespace: string,
		timeout: number = 300000
	): Promise<{ status: string; jobStatus: any }> {
		const watch = new k8s.Watch(this.kubeConfig);

		console.log(`[DEBUG] Starting job completion watch for ${jobName}`);

		return new Promise(async (resolve, reject) => {
			let jobCompleted = false;
			let timeoutId: NodeJS.Timeout;

			const clearTimeoutIfNeeded = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
			};

			// Watch job status
			const jobWatchReq = await watch.watch(
				`/apis/batch/v1/namespaces/${namespace}/jobs`,
				{},
				async (type, obj: k8s.V1Job) => {
					if (obj.metadata?.name !== jobName) {
						return;
					}

					console.log(`[DEBUG] Job ${jobName} status update:`, {
						type,
						succeeded: obj.status?.succeeded,
						failed: obj.status?.failed,
						active: obj.status?.active,
						conditions: obj.status?.conditions
					});

					const jobStatus = obj.status;
					if (jobStatus?.succeeded || jobStatus?.failed) {
						jobCompleted = true;
						clearTimeoutIfNeeded();

						const status = jobStatus.succeeded ? "succeeded" : "failed";
						console.log(`[DEBUG] Job ${jobName} completed with status: ${status}`);

						// Abort the watch after resolving to avoid race conditions
						setTimeout(() => {
							jobWatchReq?.abort();
						}, 100);

						resolve({ status, jobStatus });
					}
				},
				(err) => {
					// Don't treat AbortError as a real error if the job has already completed
					if (this.isExpectedAbortError(err, jobCompleted)) {
						console.log(`[DEBUG] Job watch aborted for ${jobName} after completion (expected)`);
						return;
					}
					console.error(`[DEBUG] Job watch error for ${jobName}:`, err);
					clearTimeoutIfNeeded();
					reject(err);
				}
			);

			// Set a timeout to avoid waiting indefinitely
			timeoutId = setTimeout(() => {
				if (!jobCompleted) {
					console.log(`[DEBUG] Job ${jobName} timeout reached, aborting watch`);
					jobWatchReq?.abort();
					reject(new Error(`Job ${jobName} did not complete within timeout`));
				}
			}, timeout);
		});
	}

		// Helper method to get logs from job pods
	private async getJobPodLogs(
		jobName: string,
		namespace: string,
		containerName?: string
	): Promise<string> {
		const k8sCoreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);

		console.log(`[DEBUG] Getting pod logs for job ${jobName}`);

		// Find the pod created by this job
		try {
			let podsResponse;
			try {
				console.log(`[DEBUG] Searching for pods with label job-name=${jobName}`);
				podsResponse = await k8sCoreApi.listNamespacedPod({
					namespace: namespace,
					labelSelector: `job-name=${jobName}`
				});
			} catch (labelErr) {
				console.log(`[DEBUG] Fallback: Searching for pods with label batch.kubernetes.io/job-name=${jobName}`);
				// Fallback: try with batch.kubernetes.io/job-name label
				podsResponse = await k8sCoreApi.listNamespacedPod({
					namespace: namespace,
					labelSelector: `batch.kubernetes.io/job-name=${jobName}`
				});
			}

			console.log(`[DEBUG] Found ${podsResponse.items?.length || 0} pods for job ${jobName}`);

			if (!podsResponse.items || podsResponse.items.length === 0) {
				console.log(`[DEBUG] No pods found for job ${jobName}`);
				return `No pods found for job ${jobName}`;
			}

			const podName = podsResponse.items[0].metadata?.name;
			if (!podName) {
				console.log(`[DEBUG] No pod name found for job ${jobName}`);
				return `No pod name found for job ${jobName}`;
			}

			console.log(`[DEBUG] Using pod: ${podName}`);

			// Determine container name if not provided
			let targetContainerName = containerName;
			if (!targetContainerName) {
				const podDetail = podsResponse.items[0];
				if (podDetail?.spec?.containers && podDetail.spec.containers.length > 0) {
					targetContainerName = podDetail.spec.containers[0].name;
					console.log(`[DEBUG] Using container name: ${targetContainerName}`);
				}
			}

			// Use the unified log retrieval method
			return this.retrievePodLogs(podName, namespace, targetContainerName || '', {
				tailLines: 1000
			});

		} catch (error) {
			console.error(`[DEBUG] Error finding pods for job ${jobName}:`, error);
			throw error;
		}
	}

	async createResource(
		apiVersion: string,
		kind: string,
		name: string,
		namespace: string,
		resourceData: any
	): Promise<any> {
		const kc = this.kubeConfig;

		console.log(`[DEBUG] createResource called with:`, {
			apiVersion,
			kind,
			name,
			namespace,
			resourceData: JSON.stringify(resourceData, null, 2)
		});

		// Clean up the resource data by removing runtime fields
		const cleanedResourceData = this.cleanResourceData(resourceData);

		// Add managed-by-automation label to the resource
		if (!cleanedResourceData.metadata) {
			cleanedResourceData.metadata = {};
		}
		if (!cleanedResourceData.metadata.labels) {
			cleanedResourceData.metadata.labels = {};
		}
		cleanedResourceData.metadata.labels["managed-by-automation"] = "n8n";

		// Add labels to template if it exists (for resources like Deployments, StatefulSets, etc.)
		if (cleanedResourceData.spec && cleanedResourceData.spec.template) {
			if (!cleanedResourceData.spec.template.metadata) {
				cleanedResourceData.spec.template.metadata = {};
			}
			if (!cleanedResourceData.spec.template.metadata.labels) {
				cleanedResourceData.spec.template.metadata.labels = {};
			}
			cleanedResourceData.spec.template.metadata.labels["managed-by-automation"] = "n8n";
		}

		console.log(`[DEBUG] Cleaned resource data:`, {
			cleanedResourceData: JSON.stringify(cleanedResourceData, null, 2)
		});

		// Handle core resources
		if (apiVersion === 'v1') {
			const coreApi = kc.makeApiClient(k8s.CoreV1Api);
			console.log(`[DEBUG] Using CoreV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'pod':
					try {
						console.log(`[DEBUG] Creating pod ${name} in namespace ${namespace}`);
						const createdPod = await coreApi.createNamespacedPod({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Pod created successfully:`, createdPod);
						return createdPod;
					} catch (error) {
						console.error(`[DEBUG] Pod creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create pod "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'service':
					try {
						console.log(`[DEBUG] Creating service ${name} in namespace ${namespace}`);
						const createdService = await coreApi.createNamespacedService({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Service created successfully:`, createdService);
						return createdService;
					} catch (error) {
						console.error(`[DEBUG] Service creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create service "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'configmap':
					try {
						console.log(`[DEBUG] Creating configmap ${name} in namespace ${namespace}`);
						const createdConfigMap = await coreApi.createNamespacedConfigMap({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] ConfigMap created successfully:`, createdConfigMap);
						return createdConfigMap;
					} catch (error) {
						console.error(`[DEBUG] ConfigMap creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create configmap "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'secret':
					try {
						console.log(`[DEBUG] Creating secret ${name} in namespace ${namespace}`);
						const createdSecret = await coreApi.createNamespacedSecret({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Secret created successfully:`, createdSecret);
						return createdSecret;
					} catch (error) {
						console.error(`[DEBUG] Secret creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create secret "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'persistentvolumeclaim':
					try {
						console.log(`[DEBUG] Creating persistentvolumeclaim ${name} in namespace ${namespace}`);
						const createdPvc = await coreApi.createNamespacedPersistentVolumeClaim({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] PersistentVolumeClaim created successfully:`, createdPvc);
						return createdPvc;
					} catch (error) {
						console.error(`[DEBUG] PersistentVolumeClaim creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create persistentvolumeclaim "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'namespace':
					try {
						console.log(`[DEBUG] Creating namespace ${name}`);
						const createdNamespace = await coreApi.createNamespace({
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Namespace created successfully:`, createdNamespace);
						return createdNamespace;
					} catch (error) {
						console.error(`[DEBUG] Namespace creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create namespace "${name}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported core resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'apps/v1') {
			const appsApi = kc.makeApiClient(k8s.AppsV1Api);
			console.log(`[DEBUG] Using AppsV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'deployment':
					try {
						console.log(`[DEBUG] Creating deployment ${name} in namespace ${namespace}`);
						const createdDeployment = await appsApi.createNamespacedDeployment({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Deployment created successfully:`, createdDeployment);
						return createdDeployment;
					} catch (error) {
						console.error(`[DEBUG] Deployment creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create deployment "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'replicaset':
					try {
						console.log(`[DEBUG] Creating replicaset ${name} in namespace ${namespace}`);
						const createdReplicaSet = await appsApi.createNamespacedReplicaSet({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] ReplicaSet created successfully:`, createdReplicaSet);
						return createdReplicaSet;
					} catch (error) {
						console.error(`[DEBUG] ReplicaSet creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create replicaset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'daemonset':
					try {
						console.log(`[DEBUG] Creating daemonset ${name} in namespace ${namespace}`);
						const createdDaemonSet = await appsApi.createNamespacedDaemonSet({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] DaemonSet created successfully:`, createdDaemonSet);
						return createdDaemonSet;
					} catch (error) {
						console.error(`[DEBUG] DaemonSet creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create daemonset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'statefulset':
					try {
						console.log(`[DEBUG] Creating statefulset ${name} in namespace ${namespace}`);
						const createdStatefulSet = await appsApi.createNamespacedStatefulSet({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] StatefulSet created successfully:`, createdStatefulSet);
						return createdStatefulSet;
					} catch (error) {
						console.error(`[DEBUG] StatefulSet creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create statefulset "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported apps resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'batch/v1') {
			const batchApi = kc.makeApiClient(k8s.BatchV1Api);
			console.log(`[DEBUG] Using BatchV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'job':
					try {
						console.log(`[DEBUG] Creating job ${name} in namespace ${namespace}`);
						const createdJob = await batchApi.createNamespacedJob({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Job created successfully:`, createdJob);
						return createdJob;
					} catch (error) {
						console.error(`[DEBUG] Job creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create job "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'cronjob':
					try {
						console.log(`[DEBUG] Creating cronjob ${name} in namespace ${namespace}`);
						const createdCronJob = await batchApi.createNamespacedCronJob({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] CronJob created successfully:`, createdCronJob);
						return createdCronJob;
					} catch (error) {
						console.error(`[DEBUG] CronJob creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create cronjob "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported batch resource type: ${kind}`
					);
			}
		} else if (apiVersion === 'networking.k8s.io/v1') {
			const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
			console.log(`[DEBUG] Using NetworkingV1Api for ${kind}`);

			switch (kind.toLowerCase()) {
				case 'ingress':
					try {
						console.log(`[DEBUG] Creating ingress ${name} in namespace ${namespace}`);
						const createdIngress = await networkingApi.createNamespacedIngress({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] Ingress created successfully:`, createdIngress);
						return createdIngress;
					} catch (error) {
						console.error(`[DEBUG] Ingress creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create ingress "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				case 'networkpolicy':
					try {
						console.log(`[DEBUG] Creating networkpolicy ${name} in namespace ${namespace}`);
						const createdNetworkPolicy = await networkingApi.createNamespacedNetworkPolicy({
							namespace: namespace,
							body: cleanedResourceData
						});
						console.log(`[DEBUG] NetworkPolicy created successfully:`, createdNetworkPolicy);
						return createdNetworkPolicy;
					} catch (error) {
						console.error(`[DEBUG] NetworkPolicy creation failed:`, error);
						throw new NodeOperationError(
							this.func.getNode(),
							`Failed to create networkpolicy "${name}" in namespace "${namespace}": ${error.message}`
						);
					}
				default:
					throw new NodeOperationError(
						this.func.getNode(),
						`Unsupported networking resource type: ${kind}`
					);
			}
		} else {
			// Handle custom resources
			try {
				console.log(`[DEBUG] Using CustomObjectsApi for ${apiVersion}/${kind}`);
				const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
				const [group, version] = apiVersion.split('/');
				console.log(`[DEBUG] Creating custom resource ${name} in namespace ${namespace} (group: ${group}, version: ${version})`);

				const response = await customObjectsApi.createNamespacedCustomObject({
					group: group,
					version: version,
					namespace: namespace,
					plural: kind.toLowerCase() + 's', // Pluralize the kind
					body: cleanedResourceData
				});
				console.log(`[DEBUG] Custom resource created successfully`);
				return response.body;
			} catch (error) {
				console.error(`[DEBUG] Custom resource creation failed:`, error);
				throw new NodeOperationError(
					this.func.getNode(),
					`Failed to create custom resource "${name}" in namespace "${namespace}": ${error.message}`
				);
			}
		}
	}

	// Helper method to clean resource data by removing runtime fields
	private cleanResourceData(resourceData: any): any {
		if (!resourceData || typeof resourceData !== 'object') {
			return resourceData;
		}

		// Create a deep copy to avoid modifying the original
		const cleaned = JSON.parse(JSON.stringify(resourceData));

		// Remove runtime fields from metadata
		if (cleaned.metadata) {
			// Remove runtime fields that should not be present when creating resources
			delete cleaned.metadata.creationTimestamp;
			delete cleaned.metadata.deletionTimestamp;
			delete cleaned.metadata.resourceVersion;
			delete cleaned.metadata.uid;
			delete cleaned.metadata.generation;
			delete cleaned.metadata.managedFields;
			delete cleaned.metadata.ownerReferences;
			delete cleaned.metadata.finalizers;
			delete cleaned.metadata.selfLink;

			// Clean annotations and labels that might cause issues
			if (cleaned.metadata.annotations) {
				// Remove kubectl and system annotations
				delete cleaned.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
				delete cleaned.metadata.annotations['deployment.kubernetes.io/revision'];

				// Remove empty annotations object
				if (Object.keys(cleaned.metadata.annotations).length === 0) {
					delete cleaned.metadata.annotations;
				}
			}
		}

		// Remove status field entirely (runtime data)
		delete cleaned.status;

		// Clean spec for specific resource types
		if (cleaned.spec) {
			// For pods, remove nodeName and other runtime fields
			if (cleaned.kind === 'Pod' || cleaned.kind === 'pod') {
				delete cleaned.spec.nodeName;

				// Clean container fields
				if (cleaned.spec.containers) {
					cleaned.spec.containers.forEach((container: any) => {
						// Remove runtime fields from containers
						delete container.terminationMessagePath;
						delete container.terminationMessagePolicy;
					});
				}

				// Clean template metadata if it exists
				if (cleaned.spec.template?.metadata) {
					delete cleaned.spec.template.metadata.creationTimestamp;
				}
			}

			// For deployments, clean template metadata
			if (cleaned.kind === 'Deployment' || cleaned.kind === 'deployment') {
				if (cleaned.spec.template?.metadata) {
					delete cleaned.spec.template.metadata.creationTimestamp;
				}
			}
		}

		console.log(`[DEBUG] Cleaned resource data, removed runtime fields`);
		return cleaned;
	}
}
