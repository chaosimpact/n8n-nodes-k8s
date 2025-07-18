import * as k8s from "@kubernetes/client-node";

// Resource type configuration
export interface ResourceConfig {
  apiVersion: string;
  apiClientFactory: (config: k8s.KubeConfig) => any;
  operations: {
    [key: string]: {
      method: string;
      requiresName?: boolean;
      requiresNamespace?: boolean;
    };
  };
}

// Resource type mapping configuration
export const RESOURCE_CONFIGS: Record<string, ResourceConfig> = {
  // Core API (v1)
  'v1': {
    apiVersion: 'v1',
    apiClientFactory: (config: k8s.KubeConfig) => config.makeApiClient(k8s.CoreV1Api),
    operations: {
      'pod': {
        method: 'Pod',
        requiresName: true,
        requiresNamespace: true
      },
      'service': {
        method: 'Service',
        requiresName: true,
        requiresNamespace: true
      },
      'configmap': {
        method: 'ConfigMap',
        requiresName: true,
        requiresNamespace: true
      },
      'secret': {
        method: 'Secret',
        requiresName: true,
        requiresNamespace: true
      },
      'persistentvolumeclaim': {
        method: 'PersistentVolumeClaim',
        requiresName: true,
        requiresNamespace: true
      },
      'namespace': {
        method: 'Namespace',
        requiresName: true,
        requiresNamespace: false
      }
    }
  },

  // Apps API (apps/v1)
  'apps/v1': {
    apiVersion: 'apps/v1',
    apiClientFactory: (config: k8s.KubeConfig) => config.makeApiClient(k8s.AppsV1Api),
    operations: {
      'deployment': {
        method: 'Deployment',
        requiresName: true,
        requiresNamespace: true
      },
      'replicaset': {
        method: 'ReplicaSet',
        requiresName: true,
        requiresNamespace: true
      },
      'daemonset': {
        method: 'DaemonSet',
        requiresName: true,
        requiresNamespace: true
      },
      'statefulset': {
        method: 'StatefulSet',
        requiresName: true,
        requiresNamespace: true
      }
    }
  },

  // Batch API (batch/v1)
  'batch/v1': {
    apiVersion: 'batch/v1',
    apiClientFactory: (config: k8s.KubeConfig) => config.makeApiClient(k8s.BatchV1Api),
    operations: {
      'job': {
        method: 'Job',
        requiresName: true,
        requiresNamespace: true
      },
      'cronjob': {
        method: 'CronJob',
        requiresName: true,
        requiresNamespace: true
      }
    }
  },

  // Networking API (networking.k8s.io/v1)
  'networking.k8s.io/v1': {
    apiVersion: 'networking.k8s.io/v1',
    apiClientFactory: (config: k8s.KubeConfig) => config.makeApiClient(k8s.NetworkingV1Api),
    operations: {
      'ingress': {
        method: 'Ingress',
        requiresName: true,
        requiresNamespace: true
      },
      'networkpolicy': {
        method: 'NetworkPolicy',
        requiresName: true,
        requiresNamespace: true
      }
    }
  }
};

// Operation type mapping
export const OPERATION_TYPES = {
  CREATE: 'create',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  PATCH: 'patch'
} as const;

// Wait condition configuration
export const WAIT_CONDITIONS = {
  READY: 'Ready',
  AVAILABLE: 'Available',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
  SUCCEEDED: 'Succeeded'
} as const;

// Parameter configuration mapping
export interface ParameterConfig {
  [operation: string]: {
    [param: string]: {
      required: boolean;
      type: string;
      default?: any;
      validation?: (value: any) => boolean;
    };
  };
}

export const PARAMETER_CONFIGS: ParameterConfig = {
  run: {
    image: { required: true, type: 'string' },
    command: { required: true, type: 'json' },
    namespace: { required: false, type: 'string', default: 'default' }
  },
  createJob: {
    jobName: { required: true, type: 'string' },
    jobImage: { required: true, type: 'string' },
    jobCommand: { required: true, type: 'json' },
    jobNamespace: { required: false, type: 'string', default: 'default' },
    restartPolicy: { required: false, type: 'string', default: 'Never' },
    cleanupJob: { required: false, type: 'boolean', default: true }
  },
  triggerCronJob: {
    cronJobName: { required: true, type: 'string' },
    cronJobNamespace: { required: false, type: 'string', default: 'default' },
    cronJobCleanup: { required: false, type: 'boolean', default: true },
    cronJobOverrides: { required: false, type: 'object', default: {} }
  },
  patch: {
    apiVersion: { required: true, type: 'string' },
    kind: { required: true, type: 'string' },
    resourceName: { required: true, type: 'string' },
    resourceNamespace: { required: false, type: 'string', default: 'default' },
    patchData: { required: true, type: 'json' }
  },
  get: {
    apiVersion: { required: true, type: 'string' },
    kind: { required: true, type: 'string' },
    resourceName: { required: true, type: 'string' },
    resourceNamespace: { required: false, type: 'string', default: 'default' }
  },
  list: {
    apiVersion: { required: true, type: 'string' },
    kind: { required: true, type: 'string' },
    resourceNamespace: { required: false, type: 'string', default: 'default' }
  },
  wait: {
    waitApiVersion: { required: true, type: 'string' },
    waitKind: { required: true, type: 'string' },
    waitResourceName: { required: true, type: 'string' },
    waitNamespace: { required: false, type: 'string', default: 'default' },
    waitCondition: { required: true, type: 'string' },
    waitTimeout: { required: false, type: 'number', default: 300 }
  },
  logs: {
    logsPodSelectionMethod: { required: false, type: 'string', default: 'podName' },
    logsPodName: { required: false, type: 'string' },
    logsLabelSelector: { required: false, type: 'string' },
    logsNamespace: { required: false, type: 'string', default: 'default' },
    logsContainer: { required: false, type: 'string' },
    logsFollow: { required: false, type: 'boolean', default: false },
    logsTail: { required: false, type: 'number', default: 100 },
    logsSinceTime: { required: false, type: 'string' }
  },
  create: {
    createResourceJson: { required: true, type: 'json' },
    createNamespace: { required: false, type: 'string', default: 'default' },
    createWatchCondition: { required: false, type: 'string', default: 'none' },
    createWatchTimeout: { required: false, type: 'number', default: 300 }
  }
};
