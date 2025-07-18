import {
  IExecuteFunctions,
  IDataObject,
  NodeOperationError,
} from "n8n-workflow";
import { PARAMETER_CONFIGS, RESOURCE_CONFIGS } from "./config";

export class ParameterHelper {
  constructor(private func: IExecuteFunctions) {}

  /**
   * Get and validate operation parameters
   * @param operation Operation type
   * @param itemIndex Data item index
   * @returns Validated parameter object
   */
  getValidatedParameters(operation: string, itemIndex: number): IDataObject {
    const config = PARAMETER_CONFIGS[operation];
    if (!config) {
      throw new NodeOperationError(
        this.func.getNode(),
        `Unsupported operation: ${operation}`
      );
    }

    const parameters: IDataObject = {};

    for (const [paramName, paramConfig] of Object.entries(config)) {
      let value = this.func.getNodeParameter(paramName, itemIndex, paramConfig.default);

      // Validate required parameters
      if (paramConfig.required && (value === undefined || value === null || value === "")) {
        throw new NodeOperationError(
          this.func.getNode(),
          `Parameter "${paramName}" is required for operation "${operation}"`
        );
      }

      // Type conversion and validation
      switch (paramConfig.type) {
        case 'json':
          if (typeof value === 'string') {
            try {
              value = JSON.parse(value);
            } catch (error) {
              throw new NodeOperationError(
                this.func.getNode(),
                `Parameter "${paramName}" must be valid JSON`
              );
            }
          }
          break;
        case 'string':
          if (value !== undefined && value !== null && typeof value !== 'string') {
            value = String(value);
          }
          break;
        case 'number':
          if (value !== undefined && value !== null && typeof value !== 'number') {
            const numValue = Number(value);
            if (isNaN(numValue)) {
              throw new NodeOperationError(
                this.func.getNode(),
                `Parameter "${paramName}" must be a valid number`
              );
            }
            value = numValue;
          }
          break;
        case 'boolean':
          if (value !== undefined && value !== null && typeof value !== 'boolean') {
            value = Boolean(value);
          }
          break;
      }

      // Custom validation
      if (paramConfig.validation && value !== undefined && value !== null) {
        if (!paramConfig.validation(value)) {
          throw new NodeOperationError(
            this.func.getNode(),
            `Parameter "${paramName}" validation failed`
          );
        }
      }

      parameters[paramName] = value;
    }

    return parameters;
  }

  /**
   * Validate array parameter
   * @param value Value to validate
   * @param paramName Parameter name
   * @returns Validated array
   */
  validateArrayParameter(value: any, paramName: string): any[] {
    if (!Array.isArray(value)) {
      throw new NodeOperationError(
        this.func.getNode(),
        `Parameter "${paramName}" must be an array`
      );
    }
    return value;
  }

  /**
   * Validate Kubernetes name format
   * @param name Name
   * @param paramName Parameter name
   */
  validateKubernetesName(name: string, paramName: string): void {
    const k8sNameRegex = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    if (!k8sNameRegex.test(name)) {
      throw new NodeOperationError(
        this.func.getNode(),
        `Parameter "${paramName}" with value "${name}" is invalid. Must match pattern: [a-z0-9]([-a-z0-9]*[a-z0-9])?`
      );
    }

    if (name.length > 63) {
      throw new NodeOperationError(
        this.func.getNode(),
        `Parameter "${paramName}" with value "${name}" is too long. Maximum length is 63 characters`
      );
    }
  }

  /**
   * Validate time format
   * @param timeString Time string
   * @param paramName Parameter name
   */
  validateTimeFormat(timeString: string, paramName: string): void {
    const parsedTime = new Date(timeString);
    if (isNaN(parsedTime.getTime())) {
      throw new NodeOperationError(
        this.func.getNode(),
        `Parameter "${paramName}" has invalid time format: ${timeString}. Please use RFC3339 format (e.g., 2024-01-01T00:00:00Z)`
      );
    }
  }

  /**
   * Generate unique resource name
   * @param baseName Base name
   * @param suffix Suffix type
   * @returns Unique name
   */
  generateUniqueName(baseName: string, suffix: 'timestamp' | 'random' = 'random'): string {
    const suffixValue = suffix === 'timestamp'
      ? Math.floor(Date.now() / 1000).toString()
      : Math.random().toString(36).substring(2, 8);

    return `${baseName}-${suffixValue}`;
  }
}

export class ResourceHelper {
  /**
   * Get resource configuration
   * @param apiVersion API version
   * @param kind Resource type
   * @returns Resource configuration
   */
  static getResourceConfig(apiVersion: string, kind: string) {
    const config = RESOURCE_CONFIGS[apiVersion];
    if (!config) {
      throw new Error(`Unsupported API version: ${apiVersion}`);
    }

    const operation = config.operations[kind.toLowerCase()];
    if (!operation) {
      throw new Error(`Unsupported resource type: ${kind} for API version: ${apiVersion}`);
    }

    return { config, operation };
  }

  /**
   * Clean resource data by removing runtime fields
   * @param resourceData Resource data
   * @returns Cleaned resource data
   */
  static cleanResourceData(resourceData: any): any {
    if (!resourceData || typeof resourceData !== 'object') {
      return resourceData;
    }

    // Deep copy to avoid modifying original data
    const cleaned = JSON.parse(JSON.stringify(resourceData));

    // Remove runtime fields from metadata
    if (cleaned.metadata) {
      const runtimeFields = [
        'creationTimestamp',
        'deletionTimestamp',
        'resourceVersion',
        'uid',
        'generation',
        'managedFields',
        'ownerReferences',
        'finalizers',
        'selfLink'
      ];

      runtimeFields.forEach(field => {
        delete cleaned.metadata[field];
      });

      // Clean annotations
      if (cleaned.metadata.annotations) {
        delete cleaned.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
        delete cleaned.metadata.annotations['deployment.kubernetes.io/revision'];

        if (Object.keys(cleaned.metadata.annotations).length === 0) {
          delete cleaned.metadata.annotations;
        }
      }
    }

    // Remove status field
    delete cleaned.status;

    // Resource type specific cleaning
    if (cleaned.spec) {
      const kind = cleaned.kind?.toLowerCase();

      if (kind === 'pod') {
        delete cleaned.spec.nodeName;

        if (cleaned.spec.containers) {
          cleaned.spec.containers.forEach((container: any) => {
            delete container.terminationMessagePath;
            delete container.terminationMessagePolicy;
          });
        }
      }

      if (cleaned.spec.template?.metadata) {
        delete cleaned.spec.template.metadata.creationTimestamp;
      }
    }

    return cleaned;
  }

  /**
   * Add managed labels
   * @param resourceData Resource data
   * @param labels Additional labels
   * @returns Resource data with added labels
   */
  static addManagedLabels(resourceData: any, labels: IDataObject = {}): any {
    if (!resourceData.metadata) {
      resourceData.metadata = {};
    }
    if (!resourceData.metadata.labels) {
      resourceData.metadata.labels = {};
    }

    // Add managed labels
    resourceData.metadata.labels["managed-by-automation"] = "n8n";

    // Add additional labels
    Object.assign(resourceData.metadata.labels, labels);

    // Add labels to template (for Deployment, StatefulSet, etc.)
    if (resourceData.spec?.template) {
      if (!resourceData.spec.template.metadata) {
        resourceData.spec.template.metadata = {};
      }
      if (!resourceData.spec.template.metadata.labels) {
        resourceData.spec.template.metadata.labels = {};
      }

      resourceData.spec.template.metadata.labels["managed-by-automation"] = "n8n";
      Object.assign(resourceData.spec.template.metadata.labels, labels);
    }

    return resourceData;
  }

  /**
   * Build watch path
   * @param apiVersion API version
   * @param kind Resource type
   * @param namespace Namespace
   * @returns Watch path
   */
  static buildWatchPath(apiVersion: string, kind: string, namespace: string): string {
    const kindLower = kind.toLowerCase();

    if (apiVersion === 'v1') {
      const pluralMap: { [key: string]: string } = {
        'pod': 'pods',
        'service': 'services',
        'configmap': 'configmaps',
        'secret': 'secrets',
        'namespace': 'namespaces'
      };

      const plural = pluralMap[kindLower] || `${kindLower}s`;
      return `/api/v1/namespaces/${namespace}/${plural}`;
    } else {
      const [group, version] = apiVersion.split('/');
      const plural = `${kindLower}s`;
      return `/apis/${group}/${version}/namespaces/${namespace}/${plural}`;
    }
  }
}

export class OutputHelper {
  /**
   * Format output - try to parse as JSON, return original string on failure
   * @param output Output content
   * @returns Formatted output
   */
  static formatOutput(output: any): any {
    if (typeof output !== 'string') {
      return output;
    }

    if (!output || output.trim() === "") {
      return output;
    }

    try {
      return JSON.parse(output);
    } catch (e) {
      return output;
    }
  }

  /**
   * Create safe promise handlers
   * @param resolve Promise resolve function
   * @param reject Promise reject function
   * @returns Safe handlers object
   */
  static createSafePromiseHandlers(resolve: Function, reject: Function) {
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

  /**
   * Check if it's an expected abort error
   * @param err Error object
   * @param completed Whether completed
   * @returns Whether it's an expected abort error
   */
  static isExpectedAbortError(err: any, completed: boolean): boolean {
    return (err.message === "aborted" || err.type === "aborted") && completed;
  }
}
