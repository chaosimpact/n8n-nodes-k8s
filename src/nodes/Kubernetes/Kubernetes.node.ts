import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeExecutionWithMetadata,
	NodeOperationError,
	NodeConnectionType,
} from "n8n-workflow";

import { K8SClient } from "./utils";

export class Kubernetes implements INodeType {
	description: INodeTypeDescription = {
		displayName: "Kubernetes",
		name: "kubernetes",
		icon: "file:k8s.svg",
		group: ["output"],
		version: 1,
		subtitle:
			'={{$parameter["operation"]}}',
		description: "Interact with Kubernetes",
		defaults: {
			name: "Kubernetes",
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: "kubernetesCredentialsApi",
				required: true,
			},
		],
		properties: [
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				options: [
					{
						name: "Get Logs",
						value: "logs",
						description: "Get logs from a pod",
						action: 'Get logs from a pod',
					},
					{
						name: "Get Resource",
						value: "get",
						description: "Get a specific Kubernetes resource",
						action: 'Get a specific kubernetes resource',
					},
					{
						name: "List Resources",
						value: "list",
						description: "List Kubernetes resources",
						action: 'List kubernetes resources',
					},
					{
						name: "Patch Resource",
						value: "patch",
						description: "Patch any Kubernetes resource",
						action: 'Patch any kubernetes resource',
					},
					{
						name: "Run Job",
						value: "createJob",
						description: "Run a Kubernetes job and get its output",
						action: 'Run a kubernetes job and get its output',
					},
					{
						name: "Run Pod",
						value: "run",
						description: "Run a pod and get its output",
						action: 'Run a pod and get its output',
					},
					{
						name: "Trigger CronJob",
						value: "triggerCronJob",
						description: "Manually trigger a CronJob to create a new Job",
						action: 'Manually trigger a cron job to create a new job',
					},
					{
						name: "Wait Resource",
						value: "wait",
						description: "Wait for a resource to reach a specific condition",
						action: 'Wait for a resource to reach a specific condition',
					},
				],
				default: "run",
			},
			// Run Pod parameters
			{
				displayName: "Image",
				name: "image",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["run"],
					},
				},
				description: "Container image to run",
			},
			{
				displayName: "Command",
				name: "command",
				type: "json",
				default: "[]",
				displayOptions: {
					show: {
						operation: ["run"],
					},
				},
				description: "Command to run in the container (JSON array)",
			},
			{
				displayName: "Namespace",
				name: "namespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["run"],
					},
				},
				description: "Kubernetes namespace",
			},
			// Create Job parameters
			{
				displayName: "Job Name",
				name: "jobName",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Name of the job to create",
			},
			{
				displayName: "Image",
				name: "jobImage",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Container image for the job",
			},
			{
				displayName: "Command",
				name: "jobCommand",
				type: "json",
				default: "[]",
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Command to run in the job container (JSON array)",
			},
			{
				displayName: "Namespace",
				name: "jobNamespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Kubernetes namespace for the job",
			},
			{
				displayName: "Restart Policy",
				name: "restartPolicy",
				type: "options",
				options: [
					{
						name: "Never",
						value: "Never",
					},
					{
						name: "OnFailure",
						value: "OnFailure",
					},
				],
				default: "Never",
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Restart policy for the job",
			},
			{
				displayName: "Cleanup Job",
				name: "cleanupJob",
				type: "boolean",
				default: true,
				displayOptions: {
					show: {
						operation: ["createJob"],
					},
				},
				description: "Whether to delete the job after completion",
			},
			// Trigger CronJob parameters
			{
				displayName: "CronJob Name",
				name: "cronJobName",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["triggerCronJob"],
					},
				},
				description: "Name of the CronJob to trigger",
			},
			{
				displayName: "Namespace",
				name: "cronJobNamespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["triggerCronJob"],
					},
				},
				description: "Kubernetes namespace for the CronJob",
			},
			{
				displayName: "Cleanup Job",
				name: "cronJobCleanup",
				type: "boolean",
				default: true,
				displayOptions: {
					show: {
						operation: ["triggerCronJob"],
					},
				},
				description: "Whether to delete the job after completion",
			},
			// CronJob Override Parameters
			{
				displayName: "Override Parameters",
				name: "cronJobOverrides",
				type: "collection",
				displayOptions: {
					show: {
						operation: ["triggerCronJob"],
					},
				},
				default: {},
				placeholder: "Add Override Parameter",
				description: "Override CronJob container parameters",
				options: [
					{
						displayName: "Override Command",
						name: "overrideCommand",
						type: "json",
						default: "[]",
						description: 'Override container command (JSON array). Example: ["/bin/bash", "-c"].',
						placeholder: "[\"/bin/bash\", \"-c\"]",
					},
					{
						displayName: "Override Args",
						name: "overrideArgs",
						type: "json",
						default: "[]",
						description: 'Override container arguments (JSON array). Example: ["echo", "Hello from n8n!"].',
						placeholder: "[\"echo\", \"Hello from n8n!\"]",
					},
					{
						displayName: "Override Environment Variables",
						name: "overrideEnvs",
						type: "fixedCollection",
						default: { env: [] },
						description: "Override or add environment variables",
						typeOptions: {
							multipleValues: true,
						},
						options: [
							{
								displayName: "Environment Variable",
								name: "env",
								values: [
									{
										displayName: "Name",
										name: "name",
										type: "string",
										default: "",
										description: "Environment variable name",
									},
									{
										displayName: "Value",
										name: "value",
										type: "string",
										default: "",
										description: "Environment variable value",
									},
								],
							},
						],
					},
				],
			},
			// Resource operations parameters
			{
				displayName: "API Version",
				name: "apiVersion",
				type: "string",
				default: "v1",
				displayOptions: {
					show: {
						operation: ["patch", "get", "list"],
					},
				},
				description: "API version of the resource (e.g., v1, apps/v1, batch/v1)",
			},
			{
				displayName: "Kind",
				name: "kind",
				type: "string",
				default: "Pod",
				displayOptions: {
					show: {
						operation: ["patch", "get", "list"],
					},
				},
				description: "Kind of the resource (e.g., Pod, Deployment, Service)",
			},
			{
				displayName: "Resource Name",
				name: "resourceName",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["patch", "get"],
					},
				},
				description: "Name of the specific resource",
			},
			{
				displayName: "Namespace",
				name: "resourceNamespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["patch", "get", "list"],
					},
				},
				description: "Kubernetes namespace for the resource",
			},
			{
				displayName: "Patch Data",
				name: "patchData",
				type: "json",
				default: "{}",
				displayOptions: {
					show: {
						operation: ["patch"],
					},
				},
				description: "JSON patch data to apply to the resource",
			},
			// Wait Resource parameters
			{
				displayName: "API Version",
				name: "waitApiVersion",
				type: "string",
				default: "v1",
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "API version of the resource to wait for",
			},
			{
				displayName: "Kind",
				name: "waitKind",
				type: "string",
				default: "Pod",
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "Kind of the resource to wait for",
			},
			{
				displayName: "Resource Name",
				name: "waitResourceName",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "Name of the resource to wait for",
			},
			{
				displayName: "Namespace",
				name: "waitNamespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "Kubernetes namespace for the resource",
			},
			{
				displayName: "Condition",
				name: "waitCondition",
				type: "options",
				options: [
					{
						name: "Available",
						value: "Available",
					},
					{
						name: "Complete",
						value: "Complete",
					},
					{
						name: "Failed",
						value: "Failed",
					},
					{
						name: "Ready",
						value: "Ready",
					},
					{
						name: "Succeeded",
						value: "Succeeded",
					},
				],
				default: "Ready",
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "Condition to wait for",
			},
			{
				displayName: 'Timeout (Seconds)',
				name: "waitTimeout",
				type: "number",
				default: 300,
				displayOptions: {
					show: {
						operation: ["wait"],
					},
				},
				description: "Timeout in seconds for waiting",
			},
			// Get Logs parameters
			{
				displayName: "Pod Name",
				name: "logsPodName",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Name of the pod to get logs from",
			},
			{
				displayName: "Namespace",
				name: "logsNamespace",
				type: "string",
				default: "default",
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Kubernetes namespace for the pod",
			},
			{
				displayName: "Container Name",
				name: "logsContainer",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Name of the container (optional, defaults to first container)",
			},
			{
				displayName: "Follow Logs",
				name: "logsFollow",
				type: "boolean",
				default: false,
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Whether to follow log output (stream logs)",
			},
			{
				displayName: "Tail Lines",
				name: "logsTail",
				type: "number",
				default: 100,
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Number of lines to show from the end of the log",
			},
			{
				displayName: "Since Time",
				name: "logsSinceTime",
				type: "string",
				default: "",
				displayOptions: {
					show: {
						operation: ["logs"],
					},
				},
				description: "Only return logs after this time (RFC3339 format, e.g., 2024-01-01T00:00:00Z)",
			},
		],
	};

	async execute(
		this: IExecuteFunctions
	): Promise<INodeExecutionData[][] | NodeExecutionWithMetadata[][]> {
		const result: INodeExecutionData[] = [];

		for (let idx = 0; idx < this.getInputData().length; idx++) {
			const credentials = await this.getCredentials(
				"kubernetesCredentialsApi",
				idx
			);
			if (credentials === undefined) {
				throw new NodeOperationError(
					this.getNode(),
					"No credentials got returned!"
				);
			}

			const k8s = new K8SClient(credentials, this);
			let data: IDataObject = {};
			const operation = this.getNodeParameter("operation", idx) as string;

			try {
				if (operation === "run") {
					const image = this.getNodeParameter("image", idx) as string;
					const command = JSON.parse(
						this.getNodeParameter("command", idx) as any
					);
					const namespace =
						(this.getNodeParameter("namespace", idx) as string) ??
						"default";
					if (!Array.isArray(command)) {
						throw new NodeOperationError(
							this.getNode(),
							"Command must be an array!"
						);
					}

					data = {
						stdout: await k8s.runPodAndGetOutput(
							image,
							command,
							undefined,
							namespace
						),
					};
				} else if (operation === "createJob") {
					const jobName = this.getNodeParameter("jobName", idx) as string;
					const jobImage = this.getNodeParameter("jobImage", idx) as string;
					const jobCommand = JSON.parse(
						this.getNodeParameter("jobCommand", idx) as any
					);
					const jobNamespace =
						(this.getNodeParameter("jobNamespace", idx) as string) ??
						"default";
					const restartPolicy =
						(this.getNodeParameter("restartPolicy", idx) as string) ??
						"Never";
					const cleanupJob = this.getNodeParameter("cleanupJob", idx) as boolean;

					if (!Array.isArray(jobCommand)) {
						throw new NodeOperationError(
							this.getNode(),
							"Job command must be an array!"
						);
					}

					const jobResult = await k8s.runJobAndGetOutput(
						jobImage,
						jobCommand,
						jobName,
						jobNamespace,
						restartPolicy,
						cleanupJob
					);

					// Return job details and output
					data = {
						jobName: jobResult.jobName,
						namespace: jobResult.namespace,
						status: jobResult.status,
						output: jobResult.output,
					};
				} else if (operation === "triggerCronJob") {
					const cronJobName = this.getNodeParameter("cronJobName", idx) as string;
					const cronJobNamespace =
						(this.getNodeParameter("cronJobNamespace", idx) as string) ??
						"default";
					const cronJobCleanup = this.getNodeParameter("cronJobCleanup", idx) as boolean;
					const cronJobOverrides = this.getNodeParameter("cronJobOverrides", idx) as IDataObject;

					if (!cronJobName || cronJobName.trim() === "") {
						throw new NodeOperationError(
							this.getNode(),
							"CronJob name is required!"
						);
					}

					// Process overrides
					let overrides: {
						command?: string[];
						args?: string[];
						envs?: { name: string; value: string }[];
					} | undefined;

					if (cronJobOverrides && Object.keys(cronJobOverrides).length > 0) {
						overrides = {};

						// Process override command
						if (cronJobOverrides.overrideCommand) {
							try {
								const commandArray = JSON.parse(cronJobOverrides.overrideCommand as string);
								if (Array.isArray(commandArray) && commandArray.length > 0) {
									overrides.command = commandArray;
								}
							} catch (error) {
								throw new NodeOperationError(
									this.getNode(),
									"Override command must be a valid JSON array!"
								);
							}
						}

						// Process override args
						if (cronJobOverrides.overrideArgs) {
							try {
								const argsArray = JSON.parse(cronJobOverrides.overrideArgs as string);
								if (Array.isArray(argsArray) && argsArray.length > 0) {
									overrides.args = argsArray;
								}
							} catch (error) {
								throw new NodeOperationError(
									this.getNode(),
									"Override args must be a valid JSON array!"
								);
							}
						}

						// Process override environment variables
						if (cronJobOverrides.overrideEnvs) {
							const envData = cronJobOverrides.overrideEnvs as { env: Array<{ name: string; value: string }> };
							if (envData.env && Array.isArray(envData.env) && envData.env.length > 0) {
								overrides.envs = envData.env.filter(env => env.name && env.name.trim() !== '');
							}
						}

						// If no valid overrides were provided, set overrides to undefined
						if (!overrides.command && !overrides.args && !overrides.envs) {
							overrides = undefined;
						}
					}

					const triggerResult = await k8s.triggerCronJob(
						cronJobName,
						cronJobNamespace,
						cronJobCleanup,
						overrides
					);

					// Return trigger details
					data = {
						jobName: triggerResult.jobName,
						namespace: triggerResult.namespace,
						cronJobName: triggerResult.cronJobName,
						status: triggerResult.status,
						createdAt: triggerResult.createdAt,
						output: triggerResult.output,
						cleaned: triggerResult.cleaned,
						overridesApplied: triggerResult.overridesApplied,
					};
				} else if (operation === "patch") {
					const apiVersion = this.getNodeParameter("apiVersion", idx) as string;
					const kind = this.getNodeParameter("kind", idx) as string;
					const resourceName = this.getNodeParameter("resourceName", idx) as string;
					const resourceNamespace =
						(this.getNodeParameter("resourceNamespace", idx) as string) ??
						"default";
					const patchData = JSON.parse(
						this.getNodeParameter("patchData", idx) as any
					);

					data = await k8s.patchResource(
						apiVersion,
						kind,
						resourceName,
						resourceNamespace,
						patchData
					);
				} else if (operation === "get") {
					const apiVersion = this.getNodeParameter("apiVersion", idx) as string;
					const kind = this.getNodeParameter("kind", idx) as string;
					const resourceName = this.getNodeParameter("resourceName", idx) as string;
					const resourceNamespace =
						(this.getNodeParameter("resourceNamespace", idx) as string) ??
						"default";

					data = await k8s.getResource(
						apiVersion,
						kind,
						resourceName,
						resourceNamespace
					);
				} else if (operation === "list") {
					const apiVersion = this.getNodeParameter("apiVersion", idx) as string;
					const kind = this.getNodeParameter("kind", idx) as string;
					const resourceNamespace =
						(this.getNodeParameter("resourceNamespace", idx) as string) ??
						"default";

					data = await k8s.listResources(
						apiVersion,
						kind,
						resourceNamespace
					);
				} else if (operation === "wait") {
					const waitApiVersion = this.getNodeParameter("waitApiVersion", idx) as string;
					const waitKind = this.getNodeParameter("waitKind", idx) as string;
					const waitResourceName = this.getNodeParameter("waitResourceName", idx) as string;
					const waitNamespace =
						(this.getNodeParameter("waitNamespace", idx) as string) ??
						"default";
					const waitCondition = this.getNodeParameter("waitCondition", idx) as string;
					const waitTimeout = (this.getNodeParameter("waitTimeout", idx) as number) * 1000; // Convert to milliseconds

					data = await k8s.waitForResource(
						waitApiVersion,
						waitKind,
						waitResourceName,
						waitNamespace,
						waitCondition,
						waitTimeout
					);
				} else if (operation === "logs") {
					const logsPodName = this.getNodeParameter("logsPodName", idx) as string;
					const logsNamespace =
						(this.getNodeParameter("logsNamespace", idx) as string) ??
						"default";
					const logsContainer = this.getNodeParameter("logsContainer", idx) as string;
					const logsFollow = this.getNodeParameter("logsFollow", idx) as boolean;
					const logsTail = this.getNodeParameter("logsTail", idx) as number;
					const logsSinceTime = this.getNodeParameter("logsSinceTime", idx) as string;

					const logs = await k8s.getLogs(
						logsPodName,
						logsNamespace,
						logsContainer || undefined,
						logsFollow,
						logsTail,
						logsSinceTime || undefined
					);

					data = {
						podName: logsPodName,
						namespace: logsNamespace,
						container: logsContainer || "default",
						logs: logs,
					};
				}
			} catch (error) {
				if (this.continueOnFail()) {
					result.push({
						json: {
							error: error.message,
						},
						pairedItem: {
							item: idx,
						},
					});
					continue;
				}
				throw error;
			}

			result.push(
				...this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(data),
					{ itemData: { item: idx } }
				)
			);
		}

		return [result];
	}
}
