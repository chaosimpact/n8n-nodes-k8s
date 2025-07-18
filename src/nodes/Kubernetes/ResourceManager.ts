import * as k8s from "@kubernetes/client-node";
import {
  IExecuteFunctions,
  NodeOperationError,
} from "n8n-workflow";
import { ResourceHelper, OutputHelper } from "./helpers";

export class ResourceManager {
  constructor(
    private kubeConfig: k8s.KubeConfig,
    private func: IExecuteFunctions
  ) {}

  /**
   * General resource operation method
   * @param operation Operation type (create, read, update, patch, delete, list)
   * @param apiVersion API version
   * @param kind Resource type
   * @param name Resource name (optional, for get, update, patch, delete)
   * @param namespace Namespace
   * @param data Resource data (optional, for create, update, patch)
   * @returns Operation result
   */
  async performResourceOperation(
    operation: string,
    apiVersion: string,
    kind: string,
    name?: string,
    namespace?: string,
    data?: any
  ): Promise<any> {
    try {
      console.log(`[DEBUG] Performing ${operation} operation on ${apiVersion}/${kind}`, {
        name,
        namespace,
        hasData: !!data
      });

      const { config } = ResourceHelper.getResourceConfig(apiVersion, kind);
      const apiClient = config.apiClientFactory(this.kubeConfig);

      // Build method name
      const methodName = this.buildMethodName(operation, kind, !!namespace);

      if (!apiClient[methodName]) {
        throw new NodeOperationError(
          this.func.getNode(),
          `Method ${methodName} not found for ${apiVersion}/${kind}`
        );
      }

      // Build parameters
      const params = this.buildMethodParams(operation, name, namespace, data);

      console.log(`[DEBUG] Calling ${methodName} with params:`, params);

      // Execute API call
      const result = await apiClient[methodName](params);

      console.log(`[DEBUG] ${operation} operation completed successfully`);
      return result;

    } catch (error) {
      console.error(`[DEBUG] ${operation} operation failed:`, error);
      throw new NodeOperationError(
        this.func.getNode(),
        `Failed to ${operation} ${kind} "${name}" in namespace "${namespace}": ${error.message}`
      );
    }
  }

  /**
   * Wait for resource to reach specified condition
   * @param apiVersion API version
   * @param kind Resource type
   * @param name Resource name
   * @param namespace Namespace
   * @param condition Condition to wait for
   * @param timeout Timeout in milliseconds
   * @returns Wait result
   */
  async waitForResourceCondition(
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    condition: string,
    timeout: number = 300000
  ): Promise<any> {
    const watch = new k8s.Watch(this.kubeConfig);

    console.log(`[DEBUG] Starting wait for ${kind}/${name} condition: ${condition}`);

    return new Promise(async (resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      let watchReq: any;
      let resourceCompleted = false;

      const { safeResolve, safeReject } = OutputHelper.createSafePromiseHandlers(resolve, reject);

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
          safeReject(new Error(`Timeout waiting for ${kind}/${name} condition: ${condition}`));
        }
      }, timeout);

      try {
        const watchPath = ResourceHelper.buildWatchPath(apiVersion, kind, namespace);

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

            if (this.checkCondition(obj, condition, kind)) {
              resourceCompleted = true;
              clearTimeoutIfNeeded();

              console.log(`[DEBUG] Resource ${kind}/${name} condition ${condition} met`);

              setTimeout(() => {
                if (watchReq) {
                  watchReq.abort();
                }
              }, 100);

              safeResolve({
                resource: obj,
                condition: condition,
                status: 'met'
              });
            }
          },
          (err) => {
            if (OutputHelper.isExpectedAbortError(err, resourceCompleted)) {
              console.log(`[DEBUG] Resource watch aborted for ${kind}/${name} after condition met (expected)`);
              return;
            }
            console.error(`[DEBUG] Resource watch error for ${kind}/${name}:`, err);
            clearTimeoutIfNeeded();
            safeReject(err);
          }
        );
      } catch (error) {
        clearTimeoutIfNeeded();
        safeReject(error);
      }
    });
  }

  /**
   * Handle custom resource operations
   * @param operation Operation type
   * @param apiVersion API version
   * @param kind Resource type
   * @param name Resource name
   * @param namespace Namespace
   * @param data Resource data
   * @returns Operation result
   */
  async handleCustomResource(
    operation: string,
    apiVersion: string,
    kind: string,
    name?: string,
    namespace?: string,
    data?: any
  ): Promise<any> {
    const customObjectsApi = this.kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    const [group, version] = apiVersion.split('/');
    const plural = `${kind.toLowerCase()}s`;

    console.log(`[DEBUG] Handling custom resource ${operation}:`, {
      group,
      version,
      plural,
      name,
      namespace
    });

    try {
      switch (operation) {
        case 'create':
          return await customObjectsApi.createNamespacedCustomObject({
            group,
            version,
            namespace: namespace!,
            plural,
            body: data
          });

        case 'get':
          return await customObjectsApi.getNamespacedCustomObject({
            group,
            version,
            namespace: namespace!,
            plural,
            name: name!
          });

        case 'list':
          return await customObjectsApi.listNamespacedCustomObject({
            group,
            version,
            namespace: namespace!,
            plural
          });

        case 'patch':
          return await customObjectsApi.patchNamespacedCustomObject({
            group,
            version,
            namespace: namespace!,
            plural,
            name: name!,
            body: data
          });

        case 'delete':
          return await customObjectsApi.deleteNamespacedCustomObject({
            group,
            version,
            namespace: namespace!,
            plural,
            name: name!
          });

        default:
          throw new Error(`Unsupported operation: ${operation}`);
      }
    } catch (error) {
      console.error(`[DEBUG] Custom resource ${operation} failed:`, error);
      throw new NodeOperationError(
        this.func.getNode(),
        `Failed to ${operation} custom resource "${name}" in namespace "${namespace}": ${error.message}`
      );
    }
  }

  /**
   * Build API method name
   * @param operation Operation type
   * @param kind Resource type
   * @param isNamespaced Whether the resource is namespaced
   * @returns Method name
   */
  private buildMethodName(operation: string, kind: string, isNamespaced: boolean): string {
    const operationMap: { [key: string]: string } = {
      'create': 'create',
      'get': 'read',
      'list': 'list',
      'patch': 'patch',
      'delete': 'delete'
    };

    const op = operationMap[operation];
    if (!op) {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    const namespacePrefix = isNamespaced ? 'Namespaced' : '';
    const kindPascal = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();

    return `${op}${namespacePrefix}${kindPascal}`;
  }

  /**
   * Build method parameters
   * @param operation Operation type
   * @param name Resource name
   * @param namespace Namespace
   * @param data Resource data
   * @returns Parameter object
   */
  private buildMethodParams(
    operation: string,
    name?: string,
    namespace?: string,
    data?: any
  ): any {
    const params: any = {};

    if (name) {
      params.name = name;
    }

    if (namespace) {
      params.namespace = namespace;
    }

    if (data && (operation === 'create' || operation === 'patch')) {
      params.body = data;
    }

    return params;
  }

  /**
   * Check resource condition
   * @param obj Resource object
   * @param condition Condition
   * @param kind Resource type
   * @returns Whether condition is met
   */
  private checkCondition(obj: any, condition: string, kind: string): boolean {
    const kindLower = kind.toLowerCase();

    switch (condition) {
      case 'Ready':
        if (kindLower === 'pod') {
          const podConditions = obj.status?.conditions || [];
          const readyCondition = podConditions.find((c: any) => c.type === 'Ready');
          return readyCondition?.status === 'True';
        }
        break;

      case 'Available':
        if (kindLower === 'deployment') {
          const deploymentConditions = obj.status?.conditions || [];
          const availableCondition = deploymentConditions.find((c: any) => c.type === 'Available');
          return availableCondition?.status === 'True';
        }
        break;

      case 'Complete':
        if (kindLower === 'job') {
          const jobConditions = obj.status?.conditions || [];
          const completeCondition = jobConditions.find((c: any) => c.type === 'Complete');
          return completeCondition?.status === 'True';
        }
        break;

      case 'Failed':
        if (kindLower === 'job') {
          const jobConditions = obj.status?.conditions || [];
          const failedCondition = jobConditions.find((c: any) => c.type === 'Failed');
          return failedCondition?.status === 'True';
        }
        if (kindLower === 'pod') {
          return obj.status?.phase === 'Failed';
        }
        break;

      case 'Succeeded':
        if (kindLower === 'pod') {
          return obj.status?.phase === 'Succeeded';
        }
        break;

      default:
        // Generic condition check
        const conditions = obj.status?.conditions || [];
        const matchingCondition = conditions.find((c: any) => c.type === condition);
        return matchingCondition?.status === 'True';
    }

    return false;
  }
}
