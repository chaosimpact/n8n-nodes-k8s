import { Writable } from "node:stream";

import * as k8s from "@kubernetes/client-node";
import {
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	NodeOperationError,
} from "n8n-workflow";

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
			await k8sCoreApi.createNamespacedPod(namespace, podSpec);
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
							let logs = "";
							const logStream = new Writable({
								write(chunk, encoding, callback) {
									logs += chunk.toString();
									callback();
								},
							});

							const logApi = new k8s.Log(kc);
							logApi
								.log(
									namespace,
									podName,
									"main-container",
									logStream
								)
								.then((req) => {
									console.log(`[DEBUG] Log request started for pod ${podName}`);
									req.on("error", (err) => {
										console.error(`[DEBUG] Log request error for pod ${podName}:`, err);
										reject(err);
									});
									req.on("complete", () => {
										console.log(`[DEBUG] Log retrieval completed for pod ${podName}. Logs length: ${logs.length}`);
										watchReq?.abort();
										resolve(this.formatOutput(logs));
									});
								})
								.catch((err) => {
									console.error(`[DEBUG] Log API error for pod ${podName}:`, err);
									watchReq?.abort();
									reject(err);
								});
						}
					},
					(err) => {
						console.error(`[DEBUG] Watch error for pod ${podName}:`, err);
						reject(err);
					}
				);
			});
			return result;
		} catch (e) {
			if (e.message === "aborted") {
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
				await k8sCoreApi.deleteNamespacedPod(podName, namespace);
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
			},
			spec: {
				template: {
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
			await k8sBatchApi.createNamespacedJob(namespace, jobSpec);
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
					await k8sBatchApi.deleteNamespacedJob(finalJobName, namespace);
					console.log(`[DEBUG] Job ${finalJobName} cleaned up successfully`);
				} catch (cleanupErr) {
					// Don't fail the whole operation if cleanup fails
					console.warn(`[DEBUG] Failed to cleanup job ${finalJobName}:`, cleanupErr);
				}
			}

			const result = {
				jobName: finalJobName,
				namespace: namespace,
				status: "completed",
				output: this.formatOutput(output),
				cleaned: cleanupJob,
			};

			console.log(`[DEBUG] Job ${finalJobName} completed successfully with result:`, result);
			return result;
		} catch (e) {
			if (e.message === "aborted") {
				console.log(`[DEBUG] Job watch was aborted for ${finalJobName}`);
				// This is fine, job watching was aborted
				return {
					jobName: finalJobName,
					namespace: namespace,
					status: "unknown",
					output: "Job watch was aborted",
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
						const patchedPod = await coreApi.patchNamespacedPod(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] Pod patch successful:`, patchedPod.body);
						return patchedPod.body;
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
						const patchedService = await coreApi.patchNamespacedService(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] Service patch successful:`, patchedService.body);
						return patchedService.body;
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
						const patchedConfigMap = await coreApi.patchNamespacedConfigMap(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] ConfigMap patch successful:`, patchedConfigMap.body);
						return patchedConfigMap.body;
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

						const patchedDeployment = await appsApi.patchNamespacedDeployment(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] Deployment patch successful:`, patchedDeployment.body);
						return patchedDeployment.body;
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
						const patchedReplicaSet = await appsApi.patchNamespacedReplicaSet(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] ReplicaSet patch successful:`, patchedReplicaSet.body);
						return patchedReplicaSet.body;
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
						const patchedDaemonSet = await appsApi.patchNamespacedDaemonSet(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] DaemonSet patch successful:`, patchedDaemonSet.body);
						return patchedDaemonSet.body;
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
						const patchedStatefulSet = await appsApi.patchNamespacedStatefulSet(
							name,
							namespace,
							patchData,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							{
								headers: {
									'Content-Type': 'application/merge-patch+json',
								},
							}
						);
						console.log(`[DEBUG] StatefulSet patch successful:`, patchedStatefulSet.body);
						return patchedStatefulSet.body;
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
				const response = await customObjectsApi.patchNamespacedCustomObject(
					group,
					version,
					namespace,
					kind.toLowerCase() + 's', // Pluralize the kind
					name,
					patchData,
					undefined,
					undefined,
					undefined,
					{
						headers: {
							'Content-Type': 'application/merge-patch+json',
						},
					}
				);
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
						const pod = await coreApi.readNamespacedPod(name, namespace);
						console.log(`[DEBUG] Pod retrieved successfully`);
						return pod.body;
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
						const service = await coreApi.readNamespacedService(name, namespace);
						console.log(`[DEBUG] Service retrieved successfully`);
						return service.body;
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
						const configMap = await coreApi.readNamespacedConfigMap(name, namespace);
						console.log(`[DEBUG] ConfigMap retrieved successfully`);
						return configMap.body;
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
						const secret = await coreApi.readNamespacedSecret(name, namespace);
						console.log(`[DEBUG] Secret retrieved successfully`);
						return secret.body;
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
						const deployment = await appsApi.readNamespacedDeployment(name, namespace);
						console.log(`[DEBUG] Deployment retrieved successfully`);
						return deployment.body;
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
						const replicaSet = await appsApi.readNamespacedReplicaSet(name, namespace);
						console.log(`[DEBUG] ReplicaSet retrieved successfully`);
						return replicaSet.body;
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
						const daemonSet = await appsApi.readNamespacedDaemonSet(name, namespace);
						console.log(`[DEBUG] DaemonSet retrieved successfully`);
						return daemonSet.body;
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
						const statefulSet = await appsApi.readNamespacedStatefulSet(name, namespace);
						console.log(`[DEBUG] StatefulSet retrieved successfully`);
						return statefulSet.body;
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
						const job = await batchApi.readNamespacedJob(name, namespace);
						console.log(`[DEBUG] Job retrieved successfully`);
						return job.body;
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

				const response = await customObjectsApi.getNamespacedCustomObject(
					group,
					version,
					namespace,
					kind.toLowerCase() + 's', // Pluralize the kind
					name
				);
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
						const pods = await coreApi.listNamespacedPod(namespace);
						console.log(`[DEBUG] Pods listed successfully, found ${pods.body.items?.length || 0} pods`);
						return pods.body;
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
						const services = await coreApi.listNamespacedService(namespace);
						console.log(`[DEBUG] Services listed successfully, found ${services.body.items?.length || 0} services`);
						return services.body;
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
						const configMaps = await coreApi.listNamespacedConfigMap(namespace);
						console.log(`[DEBUG] ConfigMaps listed successfully, found ${configMaps.body.items?.length || 0} configmaps`);
						return configMaps.body;
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
						const secrets = await coreApi.listNamespacedSecret(namespace);
						console.log(`[DEBUG] Secrets listed successfully, found ${secrets.body.items?.length || 0} secrets`);
						return secrets.body;
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
						const deployments = await appsApi.listNamespacedDeployment(namespace);
						console.log(`[DEBUG] Deployments listed successfully, found ${deployments.body.items?.length || 0} deployments`);
						return deployments.body;
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
						const replicaSets = await appsApi.listNamespacedReplicaSet(namespace);
						console.log(`[DEBUG] ReplicaSets listed successfully, found ${replicaSets.body.items?.length || 0} replicasets`);
						return replicaSets.body;
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
						const daemonSets = await appsApi.listNamespacedDaemonSet(namespace);
						console.log(`[DEBUG] DaemonSets listed successfully, found ${daemonSets.body.items?.length || 0} daemonsets`);
						return daemonSets.body;
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
						const statefulSets = await appsApi.listNamespacedStatefulSet(namespace);
						console.log(`[DEBUG] StatefulSets listed successfully, found ${statefulSets.body.items?.length || 0} statefulsets`);
						return statefulSets.body;
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
						const jobs = await batchApi.listNamespacedJob(namespace);
						console.log(`[DEBUG] Jobs listed successfully, found ${jobs.body.items?.length || 0} jobs`);
						return jobs.body;
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

				const response = await customObjectsApi.listNamespacedCustomObject(
					group,
					version,
					namespace,
					kind.toLowerCase() + 's' // Pluralize the kind
				);
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

		return new Promise(async (resolve, reject) => {
			let timeoutId: NodeJS.Timeout;
			let watchReq: any;

			// Set timeout
			timeoutId = setTimeout(() => {
				if (watchReq) {
					watchReq.abort();
				}
				reject(new Error(`Timeout waiting for ${kind}/${name} condition: ${condition}`));
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
						} else {
							// Generic condition check
							const conditions = obj.status?.conditions || [];
							const matchingCondition = conditions.find((c: any) => c.type === condition);
							conditionMet = matchingCondition?.status === 'True';
						}

						if (conditionMet) {
							clearTimeout(timeoutId);
							watchReq.abort();
							resolve({
								resource: obj,
								condition: condition,
								status: 'met'
							});
						}
					},
					(err) => {
						clearTimeout(timeoutId);
						reject(err);
					}
				);
			} catch (error) {
				clearTimeout(timeoutId);
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
		const kc = this.kubeConfig;
		const logApi = new k8s.Log(kc);

		console.log(`[DEBUG] getLogs called with:`, {
			podName,
			namespace,
			containerName,
			follow,
			tail,
			sinceTime
		});

		return new Promise((resolve, reject) => {
			let logs = "";
			const logStream = new Writable({
				write(chunk, encoding, callback) {
					logs += chunk.toString();
					callback();
				},
			});

			const logOptions: any = {};
			if (containerName) {
				logOptions.container = containerName;
			}
			if (follow) {
				logOptions.follow = follow;
			}
			if (tail !== undefined) {
				logOptions.tailLines = tail;
			}
			if (sinceTime) {
				logOptions.sinceTime = sinceTime;
			}

			console.log(`[DEBUG] Log options:`, logOptions);

			logApi.log(
				namespace,
				podName,
				containerName || '',
				logStream,
				logOptions
			).then((req) => {
				console.log(`[DEBUG] Log request started for pod ${podName}`);

				req.on("error", (err) => {
					console.error(`[DEBUG] Log request error for pod ${podName}:`, err);
					reject(err);
				});

				req.on("complete", () => {
					console.log(`[DEBUG] Log retrieval completed for pod ${podName}. Logs length: ${logs.length}`);
					resolve(this.formatOutput(logs));
				});

				// For follow mode, we need to handle the stream differently
				if (follow) {
					// Set a timeout for follow mode to prevent hanging
					setTimeout(() => {
						console.log(`[DEBUG] Log follow timeout reached for pod ${podName}, aborting`);
						req.abort();
						resolve(this.formatOutput(logs));
					}, 30000); // 30 seconds timeout for follow mode
				}
			}).catch((err) => {
				console.error(`[DEBUG] Log API error for pod ${podName}:`, err);
				reject(err);
			});
		});
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

			// Use custom objects API for CronJob since it might not be in standard BatchV1Api
			const k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
			const cronJobResponse = await k8sCustomApi.getNamespacedCustomObject(
				'batch', 'v1', namespace, 'cronjobs', cronJobName
			);
			cronJob = cronJobResponse.body as k8s.V1CronJob;
			console.log(`[DEBUG] CronJob retrieved successfully from custom objects API`);
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
					"manual-trigger": "true"
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
				template: jobTemplate.spec.template
			}
		};

		console.log(`[DEBUG] Creating job from CronJob template with overrides:`, JSON.stringify(jobSpec, null, 2));

		// Create the job
		try {
			const jobResponse = await k8sBatchApi.createNamespacedJob(namespace, jobSpec);
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
					await k8sBatchApi.deleteNamespacedJob(finalJobName, namespace);
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
				status: "completed",
				createdAt: new Date().toISOString(),
				output: this.formatOutput(output),
				cleaned: cleanupJob,
				overridesApplied: !!overrides
			};

			console.log(`[DEBUG] CronJob ${cronJobName} triggered successfully with result:`, result);
			return result;
		} catch (e) {
			if (e.message === "aborted") {
				console.log(`[DEBUG] Job watch was aborted for ${finalJobName}`);
				// This is fine, job watching was aborted
				return {
					jobName: finalJobName,
					namespace: namespace,
					cronJobName: cronJobName,
					status: "unknown",
					output: "Job watch was aborted"
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
		const kc = this.kubeConfig;
		const watch = new k8s.Watch(kc);

		console.log(`[DEBUG] Starting job completion watch for ${jobName}`);

		return new Promise(async (resolve, reject) => {
			let jobCompleted = false;

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
						jobWatchReq?.abort();

						const status = jobStatus.succeeded ? "succeeded" : "failed";
						console.log(`[DEBUG] Job ${jobName} completed with status: ${status}`);
						resolve({ status, jobStatus });
					}
				},
				(err) => {
					console.error(`[DEBUG] Job watch error for ${jobName}:`, err);
					clearTimeoutIfNeeded();
					reject(err);
				}
			);

			// Set a timeout to avoid waiting indefinitely
			const timeoutId = setTimeout(() => {
				if (!jobCompleted) {
					console.log(`[DEBUG] Job ${jobName} timeout reached, aborting watch`);
					jobWatchReq?.abort();
					reject(new Error(`Job ${jobName} did not complete within timeout`));
				}
			}, timeout);

			// Clear timeout if job completes
			const clearTimeoutIfNeeded = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
			};
		});
	}

	// Helper method to get logs from job pods
	private async getJobPodLogs(
		jobName: string,
		namespace: string,
		containerName?: string
	): Promise<string> {
		const kc = this.kubeConfig;
		const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);

		console.log(`[DEBUG] Getting pod logs for job ${jobName}`);

		// Find the pod created by this job
		try {
			let podsResponse;
			try {
				console.log(`[DEBUG] Searching for pods with label job-name=${jobName}`);
				podsResponse = await k8sCoreApi.listNamespacedPod(
					namespace,
					undefined,
					undefined,
					undefined,
					undefined,
					`job-name=${jobName}`
				);
			} catch (labelErr) {
				console.log(`[DEBUG] Fallback: Searching for pods with label batch.kubernetes.io/job-name=${jobName}`);
				// Fallback: try with batch.kubernetes.io/job-name label
				podsResponse = await k8sCoreApi.listNamespacedPod(
					namespace,
					undefined,
					undefined,
					undefined,
					undefined,
					`batch.kubernetes.io/job-name=${jobName}`
				);
			}

			console.log(`[DEBUG] Found ${podsResponse.body.items?.length || 0} pods for job ${jobName}`);

			if (!podsResponse.body.items || podsResponse.body.items.length === 0) {
				console.log(`[DEBUG] No pods found for job ${jobName}`);
				return `No pods found for job ${jobName}`;
			}

			const podName = podsResponse.body.items[0].metadata?.name;
			if (!podName) {
				console.log(`[DEBUG] No pod name found for job ${jobName}`);
				return `No pod name found for job ${jobName}`;
			}

			console.log(`[DEBUG] Using pod: ${podName}`);

			// Determine container name if not provided
			let targetContainerName = containerName;
			if (!targetContainerName) {
				const podDetail = podsResponse.body.items[0];
				if (podDetail?.spec?.containers && podDetail.spec.containers.length > 0) {
					targetContainerName = podDetail.spec.containers[0].name;
					console.log(`[DEBUG] Using container name: ${targetContainerName}`);
				}
			}

			// Get pod logs
			console.log(`[DEBUG] Retrieving logs for pod ${podName}...`);
			let logs = "";
			const logStream = new Writable({
				write(chunk, encoding, callback) {
					logs += chunk.toString();
					callback();
				},
			});

			const logApi = new k8s.Log(kc);

			return new Promise((resolve, reject) => {
				logApi.log(
					namespace,
					podName,
					targetContainerName || '',
					logStream
				).then((logReq) => {
					console.log(`[DEBUG] Log request started for pod ${podName}`);

					logReq.on("error", (err) => {
						console.error(`[DEBUG] Log error for pod ${podName}:`, err);
						reject(err);
					});

					logReq.on("complete", () => {
						console.log(`[DEBUG] Log retrieval completed for pod ${podName}. Logs length: ${logs.length}`);
						resolve(this.formatOutput(logs));
					});
				}).catch((logErr) => {
					console.error(`[DEBUG] Failed to get logs for pod ${podName}:`, logErr);
					reject(logErr);
				});
			});

		} catch (error) {
			console.error(`[DEBUG] Error finding pods for job ${jobName}:`, error);
			throw error;
		}
	}
}
