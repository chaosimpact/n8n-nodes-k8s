# @chaosimpact/n8n-nodes-k8s

This is an n8n community node that allows you to interact with Kubernetes clusters, providing a range of operations to manage your resources.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

Install community node by search name `@chaosimpact/n8n-nodes-k8s`.

### Supported Operations:

*   **Run Pod**: Execute a temporary Pod and capture its output. Useful for running one-off commands or scripts within your cluster.
*   **Run Job**: Create and run a Kubernetes Job, then retrieve its output. Ideal for batch processing tasks.
*   **Trigger CronJob**: Manually trigger an existing CronJob, optionally overriding its command, arguments, or environment variables. This creates a new Job instance from the CronJob.
*   **Patch Resource**: Apply a JSON patch to any Kubernetes resource to update its configuration dynamically.
*   **Get Resource**: Retrieve the details of a specific Kubernetes resource (e.g., Pod, Deployment, Service) by its API version, kind, name, and namespace.
*   **List Resources**: List all Kubernetes resources of a specific kind within a given API version and namespace.
*   **Wait Resource**: Pause workflow execution until a specified Kubernetes resource reaches a desired condition (e.g., "Ready", "Complete", "Succeeded", "Failed").
*   **Get Logs**: Fetch logs from a specific container within a Pod, with options to follow logs, tail lines, or filter by time.

## Credentials

Currently supports two types of credentials.

- Service account
- Kubeconfig

### Service account (Recommended)

If your n8n instance is running inside a Kubernetes cluster, a service account is the best way to communicate between n8n and Kubernetes.

Example role:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: n8n-clusterrole
rules:
- apiGroups:
  - ""
  resources:
  - pods
  - jobs
  - cronjobs
  - deployments
  - statefulsets
  verbs:
  - get
  - list
  - watch
  - create
  - update
  - patch
  - delete
```

## Usage

First create [Credentials](#credentials). If you are using Service account, choose Load from *Automatic*. If using Kubeconfig, please fill path or paste to Content box.

Then go to the workflow page and create a new step by searching for *Kubernetes*.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Compatibility

Test versions:
- 1.101.1
